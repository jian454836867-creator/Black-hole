// 文章碰撞引擎：新文章入库后，与已有文章比对主题重叠
// 同主题（cosine >= 0.65）→ 标记 same_topic → 生成合并摘要（新文章）
// 矛盾（主题重叠但观点对立）→ 标记 contradict
import { getDb } from '../db/db.js';
import { getArticle, listArticles, insertArticle, attachArticleVector, insertArticleRelation } from '../db/repo.js';
import { embedder } from '../model/embedder.js';
import { llmAvailable } from '../pipeline/llm.js';

const ARTICLE_SIM_THRESHOLD = 0.65; // 文章级主题重叠阈值（比 insight 的 0.70 低，因为文章更长更稳定）

/**
 * 新文章入库后，扫描已有文章找主题重叠
 * @param {string} articleId 新文章 ID
 * @param {object} opts { judge } judge 暂不用（纯向量比对）
 * @returns {Promise<Array>} 产生的 article_relations
 */
export async function compareNewArticle(articleId, { judge = null } = {}) {
  const db = getDb();
  const newArticle = getArticle(articleId);
  if (!newArticle) return [];

  // 取新文章向量
  const row = db.prepare('SELECT rowid FROM article_ids WHERE article_id=?').get(articleId);
  if (!row) return [];
  const vecRow = db.prepare('SELECT embedding FROM vec_articles WHERE rowid=?').get(row.rowid);
  if (!vecRow) return [];
  const buf = Buffer.from(vecRow.embedding);
  const dim = buf.length / 4;
  const newVec = Array.from(new Float32Array(buf.buffer, buf.byteOffset, dim));

  // 扫描所有已有文章的向量
  const allRows = db.prepare('SELECT ai.rowid, ai.article_id FROM article_ids ai').all();
  const relations = [];
  for (const r of allRows) {
    if (r.article_id === articleId) continue;
    const v = db.prepare('SELECT embedding FROM vec_articles WHERE rowid=?').get(r.rowid);
    if (!v) continue;
    const vBuf = Buffer.from(v.embedding);
    const vArr = Array.from(new Float32Array(vBuf.buffer, vBuf.byteOffset, dim));
    const cos = newVec.reduce((s, x, i) => s + x * vArr[i], 0);

    if (cos >= ARTICLE_SIM_THRESHOLD) {
      const other = getArticle(r.article_id);
      if (!other) continue;

      // 同主题：生成合并摘要
      let mergedId = null;
      let overlapDesc = `主题相似（cosine=${cos.toFixed(2)}）`;
      if (llmAvailable()) {
        try {
          const { answer } = await import('../pipeline/llm.js');
          const merged = await generateMergedSummary(newArticle, other);
          if (merged) {
            mergedId = insertArticle({
              url: `merged://${newArticle.id}+${other.id}`,
              title: `🔗 ${merged.title}`.slice(0, 100),
              content: merged.content,
              summary: merged.summary,
            });
            const [mvec] = await embedder.embed([merged.content.slice(0, 500)]);
            attachArticleVector(mergedId, mvec);
            overlapDesc = merged.summary || overlapDesc;
          }
        } catch (e) {
          console.error('[article-comparator] 合并摘要生成失败:', e.message);
        }
      }

      const relId = insertArticleRelation({
        articleAId: articleId,
        articleBId: r.article_id,
        relationType: 'same_topic',
        overlap: overlapDesc,
        mergedArticleId: mergedId,
      });
      relations.push({ id: relId, type: 'same_topic', cos: cos.toFixed(3), mergedId });
      console.error(`[article-comparator] 碰撞: "${(newArticle.title || '').slice(0, 20)}" ↔ "${(other.title || '').slice(0, 20)}" cos=${cos.toFixed(3)}`);
    }
  }
  return relations;
}

// 用 DeepSeek 生成两篇文章的合并摘要
async function generateMergedSummary(a, b) {
  const system = `你是文章合并器。给定两篇主题相似的文章，生成：
1. 一个合并标题（10 字以内）
2. 一段合并摘要（100-200 字，融合两篇的核心观点，标注异同）
只输出 JSON：{"title":"...","summary":"..."}
不要输出任何 JSON 之外的内容。`;
  const prompt = `文章A（${a.url}）：\n${(a.content || '').slice(0, 3000)}\n\n文章B（${b.url}）：\n${(b.content || '').slice(0, 3000)}\n\n请合并。`;
  // 直接调 DeepSeek（不经过 rag 的 answer 函数，因为这不是问答）
  const { _chat: chat } = await import('../pipeline/llm.js');
  const raw = await chat({ model: 'deepseek-chat', system, prompt, jsonMode: true, useCache: false });
  try {
    const p = JSON.parse(raw);
    if (p.title && p.summary) return { title: String(p.title).slice(0, 50), summary: String(p.summary).slice(0, 300), content: `${p.title}\n\n${p.summary}\n\n来源：\n- ${a.url}\n- ${b.url}` };
  } catch {}
  return null;
}
