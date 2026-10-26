# 更新日志

本项目遵循「每一步可独立验收、可回滚」的推进方式。下面按时间倒序记录。

---

## v0.1.0 — 首个公开版本（2026-10-26）

第一个可运行的完整版本：本地黑盒知识库，三端接入（GUI / 微信 / HTTP API），
claim 级 8 类关系判定引擎落地。

### 核心能力

| 模块 | 状态 | 说明 |
|---|---|---|
| 双路检索 | ✅ | 向量（纯 cosine `1-L2²/2`）+ FTS5 BM25，7:3 加权融合 |
| 入库问答 | ✅ | RAG 三层阈值防线，`SIM_STRONG=0.70` 以下直接回「请持续投喂」，不浪费模型调用 |
| claim 级关系判定 | ✅ | 8 类关系 + 优先级短路，规则优先、LLM 兜底 |
| 文章分支 | ✅ | 微信发 URL → 抓正文 → 整篇存 `articles` → 文章级向量 + 文章碰撞 |
| 微信 iLink 桥 | ✅ | 发文字=入库、`问xxx`=提问、`/clear`=清空；短消息价值过滤 |
| 价值过滤 | ✅ | 寒暄/纯标点/<12 字不入库；事实陈述（「我老板是X」）例外放行 |
| GUI | ✅ | 上下 6:4 布局，碰撞卡片内联「✓收录 / ✕忽略」 |
| 桌面启动器 | ✅ | `start.vbs` 静默起服务 + 弹 Edge 应用窗口，无黑框 |

### 本次迭代重点：claim 级关系判定引擎

替代原先的「cos 三档硬阈值」（≥0.95 拒绝 / 0.82–0.95 归档 / <0.82 入库）。
硬阈值的根本问题是**用相似度代替语义判断**——bge 短句向量退化实测
`cos(你好, 李白) ≈ 0.71`，绝对阈值必然误判。

新流程：

```
新条目 → 向量召回 top-20 → claim 抽取 → claim 对齐 → 优先级短路判定
       → 写关系边 + 更新条目状态（逻辑失效，不物理删）
```

**8 类关系**

| 类型 | 触发条件 | 动作 |
|---|---|---|
| `EQUIVALENT` | cos ≥ 0.88 + claim 对齐无冲突 + 极性一致 | 新条目归档，保留旧条目 |
| `CONTAINS` | claim 子集关系（一方独有 claim） | 被包含方 `superseded` |
| `OVERLAPS` | 有匹配 + 各有独有 + 无冲突 | 建 relation_group，聚合成互补 |
| `CONTRADICTS` | 同 subject+slot，值/极性冲突且差异无法解释 | 双方入库 + `conflict_flag=1` |
| `PSEUDO_CONFLICT` | 值冲突但条件/单位/口径/来源不同 | 独立入库，按来源分组展示 |
| `VERSION` | 同槽位不同值 + 时间区间不重叠 | 旧版 `superseded` + 写 `valid_to` |
| `RELATED` | 共享实体 + cos ≥ 0.50 | 写 RELATED 边，检索仅在召回不足时扩展 |
| `UNRELATED` | 以上都不满足 | 独立入库，不写边 |

**判定优先级（必须短路，否则互相抢）**

```
EQUIVALENT → CONTAINS → OVERLAPS → 同槽位分歧(CONTRADICTS/PSEUDO/VERSION) → RELATED → UNRELATED
```

顺序理由：等价先判（否则被误判成包含）；包含次之（子集关系稳定）；
OVERLAPS 必须早于同槽位分歧（否则「同 subject 不同 slot 的不同值」会被误判为矛盾）。

**实现取舍**

- Claim 抽取默认**纯规则**（正则 + 数值/日期归一），零 API 消耗
  —— `CLAIM_EXTRACT=llm` 可开启 LLM 抽取，精度更高、成本翻倍
- 8 类判定**不调 LLM**，全部走规则 + claim 对齐，结果可复现
- 关系边落 `relations` 表（type/subtype/confidence/evidence），
  条目状态落 `insights.status`（active/superseded/conflicted）
- 检索侧按关系聚合：等价折叠 / 版本取 active / 冲突并列 / 重叠聚类

### 修复记录

| 问题 | 原因 | 修复 |
|---|---|---|
| 检索分数失真，无关词条被拉满 | min-max 归一化把最差分拉 1.0 | 直接用余弦，不归一化 |
| 短句「蹭」高分 | bge 短句向量挤向通用语义中心 | 三层防线：入库过滤 + 0.70 强相关线 + 上下文只注入强命中 |
| 极性相反被判成等价 | `align` 只比 value 不比 polarity | polarity 不同即进 conflicts |
| 互补内容被判成矛盾 | `OVERLAPS` 判定晚于 contradic 分支 | 把 OVERLAPS 提到同槽位分歧之前 |
| 数值「10亿」与「1000000000」不等 | 未做单位归一 | `normalizeValue` 归一亿/万/千/百 |
| vite dev 起不来、黑框一闪而过 | vite EBUSY + bat 中文编码 + PowerShell 执行策略 | 改静态伺服 `src/server/static.js` + `start.vbs` 静默启动 |
| 静态伺服 404 | `__dirname` 层级算错（`../gui/dist`） | 改 `../../gui/dist` |

### 已知限制

- 规则 claim 抽取只覆盖中文常见句式（「X是Y」「X在Y」「X做了Y」「X花了N」），
  复杂长句要靠 `CLAIM_EXTRACT=llm`
- 阈值未经标注集校准（方案里建议每类 ≥200 对画 PR 曲线），当前值为经验值
- 桌面端走 Edge `--app` 窗口，非独立 exe
- 微信桥需自己扫码登录，token 存在本地 `config.json`（已 gitignore）

### 下一步

- [ ] 建标注集，逐类校准 cos / NLI 阈值
- [ ] claim 对齐支持条件（region/segment）与粒度（granularity）
- [ ] 检索侧 shadow mode 对比聚合前后效果
- [ ] 独立桌面打包（Tauri / Electron，含 Node 后端）
