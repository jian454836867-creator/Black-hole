// RAG 问答：双路召回 → 相似度阈值过滤 → 组装上下文 → DeepSeek → 带引用回答
//
// 阈值策略（bge-small-zh 实测校准，2026-10-26）：
// 短句向量退化实测：cos(你好, 李白) ≈ 0.71 > cos(苏轼黄州, 李白) ≈ 0.53
// cos(留白, 李白) ≈ 0.66 —— 短句 embedding 挤向"通用语义中心"，
// 与任何查询都算"相关"，绝对阈值不可靠。
//
// 三层防线：
//   1) 入库侧：filter.js 价值过滤（<12 字短句不入库，见 src/pipeline/filter.js）
//   2) 召回侧：相对比例 relFloor = max(0.40, 0.55*top1)，绝对下限 0.35
//   3) 上下文侧：相关度注入 prompt，LLM 只把 >= 0.70 的当依据；
//      top1 < SIM_STRONG(0.70) → 直接回"请持续投喂"，不调大模型
import { search } from '../search/search.js';
import { searchArticles } from '../search/search-articles.js';
import { getDb } from '../db/db.js';
import { answer, llmAvailable } from './llm.js';

export const SIM_ABS_MIN = 0.35;
export const SIM_REL_RATIO = 0.55;
export const SIM_REL_FLOOR = 0.40;
export const SIM_CONTEXT_MIN = 0.55; // 注入上下文内容的最低相似度（低于此内容隐藏，只留编号）
export const SIM_STRONG = 0.70;      // "强相关"判定点：top1 低于此 → 库里没有该主题
const NO_KB_ANSWER = '库中暂无相关观点。请持续投喂相关知识，黑盒会在积累足够素材后给出有依据的回答。';

/**
 * @param {string} question 用户问题
 * @param {object} opts { k=5, deep=false, privacy='normal' }
 * @returns {Promise<{answer, citations, localOnly, noKnowledge, latencyMs}>}
 */
export async function ask(question, { k = 5, deep = false, privacy = 'normal' } = {}) {
  const { hits } = await search(question, { k });
  const db = getDb();
  const insStmt = db.prepare('SELECT * FROM insights WHERE id=?');
  const relStmt = db.prepare(
    `SELECT r.*, a.content AS ca, b.content AS cb FROM relations r
     JOIN insights a ON a.id=r.insight_a_id JOIN insights b ON b.id=r.insight_b_id
     WHERE r.insight_a_id=? OR r.insight_b_id=?`
  );

  // 文章级检索（全量：articles 表 + vec_articles）
  const articleHits = await searchArticles(question, { k: 3 });

  // 召回侧过滤
  const top1 = hits.length ? hits[0].score : 0;
  const relFloor = Math.max(SIM_REL_FLOOR, SIM_REL_RATIO * top1);
  const goodHits = hits.filter(h => h.score >= SIM_ABS_MIN && h.score >= relFloor);

  // 无有效命中 → 直接告知"请持续投喂"
  if (!goodHits.length) {
    return { answer: NO_KB_ANSWER, citations: [], localOnly: true, noKnowledge: true, latencyMs: undefined };
  }

  // 关键判定：所有命中都低于强相关线 → 库里确实没有该主题，直接告知，不调大模型
  // （解决 bge 短句退化导致的"留白蹭 0.66 被 LLM 当依据"问题）
  const maxScore = Math.max(...goodHits.map(h => h.score));
  if (maxScore < SIM_STRONG) {
    return { answer: NO_KB_ANSWER, citations: [], localOnly: true, noKnowledge: true, latencyMs: undefined };
  }

  const contextItems = [];
  const citations = [];
  for (const h of goodHits) {
    const row = insStmt.get(h.insightId);
    if (!row) continue;
    // 只把 >= SIM_STRONG 的命中注入上下文内容并进引用列表；
    // 低于强相关线的命中完全丢弃（不进上下文、不进引用）
    if (h.score >= SIM_STRONG) {
      contextItems.push({ ...row, _score: h.score, _via: h.via });
      citations.push({ id: row.id, content: row.content, sourceUrl: row.source_url || null });
      const rels = relStmt.all(row.id, row.id).filter(r => r.user_confirmed !== -1);
      if (rels.length) row._relations = rels.map(r => ({
        type: r.relation_type, explanation: r.explanation,
        other: r.ca === row.content ? r.cb : r.ca,
      }));
    }
  }
  // 过滤后无强相关 → 无知识
  if (!contextItems.length) {
    return { answer: NO_KB_ANSWER, citations: [], localOnly: true, noKnowledge: true, latencyMs: undefined };
  }

  // 文章级命中：注入上下文 + 进引用（带出处链接）
  for (const a of articleHits) {
    if (a.score >= 0.60) {
      contextItems.push({
        id: a.id, content: `[文章] ${a.title || a.url}\n${(a.summary || a.content || '').slice(0, 500)}`,
        _score: a.score, _via: 'article', _isArticle: true,
      });
      citations.push({ id: a.id, content: `📄 ${a.title || a.url}`, sourceUrl: a.url, isArticle: true });
    }
  }

  // 隐私路由：private 数据绝不触网；无 Key 时也降级为本地词条回答
  const localOnly = privacy === 'private' || !llmAvailable();
  const text = await answer(question, contextItems, { deep, localOnly });

  // 双保险：LLM 仍声称"暂无相关观点"且无强相关 → 走无知识路径
  const hasStrong = contextItems.some(c => !c._weak);
  const looksNoKB = /暂无相关观点/.test(text) && !hasStrong;
  return {
    answer: looksNoKB ? NO_KB_ANSWER : text,
    citations: looksNoKB ? [] : citations,
    localOnly,
    noKnowledge: looksNoKB,
    latencyMs: undefined,
  };
}
