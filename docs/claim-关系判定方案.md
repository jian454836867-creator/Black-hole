0. 整体 Pipeline
text
new_entry
  → 1. 规范化与 claim 抽取
  → 2. 向量召回 top-k 候选
  → 3. 对每个候选做 claim 对齐
  → 4. 按优先级逐类判定（EQUIVALENT → CONTAINS → 同槽位分支 → OVERLAPS → RELATED → UNRELATED）
  → 5. 写关系边 + 更新条目状态
  → 6. 检索侧按关系聚合
判定器用规则优先、模型兜底：能用槽位规则判的不要上 LLM；LLM/NLI 只处理规则覆盖不了的语义。

1. 公共基础：Claim 表示
每条 entry 抽成 claim 列表，这是后面所有判定的基础。

python
@dataclass
class Claim:
    subject: str            # 归一化实体 ID
    slot: str               # 属性/谓词，如 ceo / price / location
    value: Any              # 归一化值（实体 ID、数值、日期、字符串）
    polarity: int           # 1 肯定 / -1 否定
    condition: dict         # {"region":"CN","segment":"SMB"}
    valid_time: tuple       # (from, to) 可为空
    unit: str | None
    granularity: str | None # 口径/粒度
    source: str
    confidence: float
    text_span: str          # 原文片段，用于 NLI 和溯源
抽取方式：

实体/槽位/值：规则 + 小模型（NER + 关系抽取），或用 LLM 结构化抽取，输出 JSON 后校验。

条件/时间/单位/口径：正则 + 日期解析 + 单位归一（如 "10亿" → 1e9）。

归一化：实体走 alias 表/向量聚类；数值统一单位；日期统一 ISO；布尔和极性统一。

检索工具不一定要抽得很全。MVP 至少抽 subject / slot / value / valid_time / source，条件、单位可先用原文文本挂在 qualifier 上。

2. 候选召回
python
candidates = vector_index.search(embed(new_entry), top_k=50)
candidates = rerank(query=new_entry, docs=candidates, top_k=20)
向量召回用条目级 embedding；再对候选做 cross-encoder 精排。

同时用 subject 做倒排过滤，保证同实体候选不漏。

top_k 不用太大，20 足够；关系判定成本主要在 NLI。

3. Claim 对齐
对 (new_entry, cand) 的 claim 集合做对齐：

python
def align_claims(A: list[Claim], B: list[Claim]) -> Alignment:
    # 1. subject 归一后相同才可对齐
    # 2. slot 相同或同义（走 slot 同义词表）
    # 3. value 归一后比较；不同则记为 value_conflict
    # 4. 用 embedding 做 slot 软匹配兜底
    matched, only_a, only_b, conflicts = [], [], [], []
    for a in A:
        best = max(B, key=lambda b: slot_sim(a, b))
        if slot_sim(a, best) >= 0.8 and a.subject == best.subject:
            if values_equal(a, best): matched.append((a, best))
            else: conflicts.append((a, best))
        else:
            only_a.append(a)
    ...
    return Alignment(matched, only_a, only_b, conflicts)
values_equal 要处理：数值容差、单位换算、日期、实体别名、字符串规范化。

4. 8 类判定器
4.1 EQUIVALENT（等价重复）
信号：cos 高 + 双向 entailment + claim 对齐后无冲突 + 极性一致。

python
def is_equivalent(A, B, cos, nli):
    if cos < 0.90: return False
    align = align_claims(A, B)
    if align.conflicts or align.only_a or align.only_b:
        # 允许极小的元数据差异，但事实集合要一致
        if len(align.matched) == 0: return False
        if not is_metadata_only(align.only_a + align.only_b): return False
    # 双向 NLI
    e_ab = nli(A.text, B.text)  # entailment prob
    e_ba = nli(B.text, A.text)
    return min(e_ab, e_ba) >= 0.85
动作：拒绝新条目，合并 sources、取更高 confidence、更新 updated_at。subtype 记 exact / paraphrase / alias。

边界：别名重复靠实体归一识别，不靠 cos；"近似重复"如果值有细微差异，不能判 EQUIVALENT，走 OVERLAPS。

4.2 CONTAINS（包含/增量）
信号：单向 entailment + claim 子集关系。

python
def contains_direction(A, B, nli):
    align = align_claims(A, B)
    # A 包含 B：B 的每个 claim 都能在 A 找到匹配，且 A 有独有 claim
    b_covered = len(align.matched) == len(B) and not align.only_b
    a_has_extra = len(align.only_a) > 0
    if b_covered and a_has_extra:
        if nli(B.text, A.text) >= 0.85:  # B entails A? 注意方向
            return "A_CONTAINS_B"
    ...
注意 entailment 方向：A ⊇ B 意味着 B 能推出 A 的一部分，但文本 entailment 方向要按"谁信息更多"来定，建议以 claim 子集为主、NLI 做验证。

动作：新条目覆盖旧条目时，旧条目 status=superseded，新条目继承旧条目的 sources 和 relation_group_id，写 CONTAINS 边。不物理删除。

边界：细化/特化（新更具体）也走这里，subtype=specialization；泛化则反向。

4.3 VERSION（时间版本/替代）
信号：同 subject + 同 slot，值不同，但 valid_time 不同或版本号不同。

python
def is_version(conflict_pairs, A, B):
    for a, b in conflict_pairs:
        if a.slot != b.slot: continue
        if a.valid_time and b.valid_time and not overlap(a.valid_time, b.valid_time):
            if is_temporal_fact(a.slot):   # CEO/价格/政策 等
                return True
        if a.metadata.get("version") and b.metadata.get("version"):
            return True
    return False
is_temporal_fact 用一个 slot 白名单：CEO、price、policy、status、address 等；静态事实（出生地、化学式）不判 VERSION。

动作：双时态存储，旧条目标 superseded 并写 valid_to；新条目 valid_from。写 VERSION 边。检索默认返回 active，历史查询展开时间线。

边界：时间重叠的同槽位不同值，不是 VERSION，进 CONTRADICTS/PSEUDO_CONFLICT 分支。

4.4 CONTRADICTS（真矛盾）
信号：同 subject + 同 slot + 条件/时间/口径/来源都无法解释差异 + 值冲突或极性相反。

python
def is_contradiction(A, B, nli):
    align = align_claims(A, B)
    for a, b in align.conflicts:
        if a.slot != b.slot: continue
        # 排除可解释差异
        if time_differs(a, b) and is_temporal_fact(a.slot): continue
        if condition_differs(a, b): continue
        if unit_differs(a, b) or granularity_differs(a, b): continue
        if source_differs(a, b) and not can_adjudicate(a, b): 
            return "PSEUDO"   # 交给 PSEUDO_CONFLICT
        # 值冲突：实体不同 / 数值超容差 / 极性相反
        if value_conflict(a.value, b.value) or a.polarity != b.polarity:
            if nli(a.text_span, b.text_span) == "contradiction" >= 0.7:
                return "CONTRADICTS"
    return None
动作：直接入库，写 CONTRADICTS 边，conflict_flag=true，高优先级人工审核队列。不自动覆盖任何一方。

边界：NLI 判矛盾 + 槽位规则双确认，降低误报；只靠 cos<0.82 判矛盾是错的。

4.5 PSEUDO_CONFLICT（伪冲突）
信号：看似同槽位不同值，但 condition/unit/granularity/source 不同导致都真。

这是 CONTRADICTS 的兜底分支，实现上是"检测到潜在冲突后，检查 qualifier 差异"：

python
def classify_potential_conflict(a, b):
    if condition_differs(a, b):  return "condition_conflict"
    if unit_differs(a, b):       return "unit_conflict"
    if granularity_differs(a, b):return "granularity_conflict"
    if source_differs(a, b):     return "source_conflict"
    return None  # 真矛盾
动作：独立入库或合并为带条件的多值 claim，写 PSEUDO_CONFLICT 边，subtype 记具体原因。检索时按条件/口径/来源分组展示，不报"矛盾"。

边界：来源冲突如果不能判定谁对，默认保留双方、按来源可信度排序，标 source_conflict，不进人工矛盾队列。

4.6 OVERLAPS（部分重叠/互补）
信号：claim 部分重叠，各有独有信息，无冲突，非包含。

python
def is_overlaps(A, B):
    align = align_claims(A, B)
    if align.conflicts: return False
    inter = len(align.matched)
    if inter == 0: return False
    if len(align.only_a) == 0 or len(align.only_b) == 0:
        return False  # 是包含，不是重叠
    return inter / (inter + len(align.only_a) + len(align.only_b)) >= 0.2
动作：独立入库，写 OVERLAPS 边，建 relation_group_id。检索时聚类、生成互补摘要，不折叠成一条。

边界：细化/泛化如果不想单独建层级，可归到这里用 subtype=specialization/generalization；上下位、部分整体也用这个 subtype 表达。

4.7 RELATED（相关/因果）
信号：主题相关、同事件、因果，但不满足以上任何关系。

python
def is_related(A, B, cos):
    if cos < 0.6: return False
    if share_entities(A, B) >= 1: return True
    if same_event(A, B): return True          # 事件共指/时间地点相近
    if causal_extractor(A.text, B.text): return True
    return False
动作：独立入库，写 RELATED 边（可带 subtype=causal/same_event）。检索时只在召回不足时做 topN 扩展，防止查询漂移。

4.8 UNRELATED（无关）
默认分支：不满足以上任何一类。

动作：独立入库，不写关系边（或写 UNRELATED 仅用于审计）。检索时不折叠、不扩展。

5. 判定优先级（关键）
关系判定必须按顺序短路，否则会互相抢：

python
def classify(new, cand, cos, nli):
    if is_equivalent(...):        return "EQUIVALENT"
    d = contains_direction(...)
    if d:                         return "CONTAINS"
    pc = classify_potential_conflict_all(...)   # 同槽位不同值
    if pc == "CONTRADICTS":       return "CONTRADICTS"
    if pc in ("condition","unit","granularity","source"): return "PSEUDO_CONFLICT"
    if is_version(...):           return "VERSION"
    if is_overlaps(...):          return "OVERLAPS"
    if is_related(...):           return "RELATED"
    return "UNRELATED"
顺序理由：等价先判（否则会被误判成包含）；包含次之（子集关系稳定）；同槽位分支在重叠前判（冲突优先于互补）；VERSION 在 CONTRADICTS 之后是因为"时间不同"要先排除真矛盾。

实际实现里 VERSION 和 CONTRADICTS 可以合并成一个"同槽位分歧"判定函数，内部分流到 VERSION / PSEUDO_CONFLICT / CONTRADICTS，减少重复对齐。

6. 存储 Schema
json
{
  "relation_id": "rel_001",
  "from_entry": "e_new",
  "to_entry": "e_old",
  "type": "CONTRADICTS",
  "subtype": "source_conflict",
  "direction": "undirected",
  "confidence": 0.91,
  "qualifiers": {"slot": "ceo", "time": "2025", "source_a": "a", "source_b": "b"},
  "evidence": ["原文片段A", "原文片段B"],
  "status": "active",
  "created_at": "..."
}
条目上保留：canonical_id、relation_group_id、status(active/superseded/conflicted/corrected)、valid_time、sources、conflict_flag。逻辑失效，不物理删除。

7. 检索侧聚合实现
python
def aggregate(results):
    groups = group_by(results, key=lambda r: r.canonical_id or r.relation_group_id)
    out = []
    for g in groups:
        if any(r.type == "EQUIVALENT"):      # 折叠
            out.append(merge_sources(g))
        elif any(r.type == "CONTAINS"):      # 取父，子作证据
            out.append(parent_with_children(g))
        elif any(r.type == "VERSION"):       # 默认 active
            out.append(select_active(g, query_is_historical))
        elif any(r.type == "CONTRADICTS"):   # 并列 + 标冲突
            out.append(parallel_with_conflict_flag(g))
        elif any(r.type == "PSEUDO_CONFLICT"):# 分组
            out.append(group_by_qualifier(g))
        elif any(r.type == "OVERLAPS"):      # 聚类互补摘要
            out.append(cluster_summary(g))
        else:
            out.extend(g)                    # UNRELATED/RELATED 不折叠
    # RELATED 扩展仅在召回不足时触发，限 topN
    return rerank(out)
返回结果带：canonical_id、relation_type、status、valid_time、conflict_flag、sources，前端据此做折叠/版本切换/冲突提示。

8. 阈值校准与评估
校准：

建标注集：每个关系类型 ≥ 200 对，含难例（近义、条件冲突、时间更新、来源冲突）。

对 cos、NLI entailment/contradiction 阈值画 PR 曲线，按业务选点（检索工具通常优先压冲突误报率）。

不同 embedding/NLI 模型阈值不同，不要硬编码 0.95/0.82。

每类单独校准，EQUIVALENT 的 cos 阈值通常高于 OVERLAPS。

评估指标：

关系分类：每类 P/R/F1 + 混淆矩阵，重点看 CONTRADICTS↔PSEUDO_CONFLICT、EQUIVALENT↔OVERLAPS、CONTAINS↔OVERLAPS 的混淆。

端到端：nDCG@10、重复结果率、冲突误报率、版本选择正确率。

人工抽检：冲突边和合并结果必须抽检，检索工具最怕静默覆盖。

上线策略：先 shadow mode 跑关系判定，不改变检索结果，对比聚合前后的 nDCG 和人工满意度，再逐步开启折叠和版本选择，冲突提示最后开。

9. 实现顺序建议
Claim 抽取 + 实体/时间/单位归一（地基）。

候选召回 + claim 对齐（大多数判定都依赖它）。

EQUIVALENT + UNRELATED（先跑通折叠，收益最大、判定最稳）。

CONTAINS + VERSION（合并和版本选择）。

CONTRADICTS + PSEUDO_CONFLICT（冲突检测，需要 NLI 和规则）。

OVERLAPS + RELATED（聚类和扩展，最后做）。

这样每一层都能独立上线、独立评估，出问题能回滚到上一层。