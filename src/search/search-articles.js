// 文章级语义检索：vec_articles knn → 余弦相似度 → Top-K
// sqlite-vec 要求 knn 查询用 k=? 参数（不能只靠 LIMIT）
import { getDb } from '../db/db.js';
import { embedder } from '../model/embedder.js';

export async function searchArticles(query, { k = 3 } = {}) {
  const db = getDb();
  try {
    const [qvec] = await embedder.embed([query]);
    const qf = Float32Array.from(qvec);
    const limit = Math.max(1, k * 2);
    const rows = db.prepare(
      `SELECT ai.rowid, ai.article_id, v.distance
       FROM vec_articles v
       WHERE v.embedding MATCH ? AND v.k = ?
       ORDER BY v.distance ASC`
    ).all(qf, limit);
    if (!rows.length) return [];
    const artStmt = db.prepare('SELECT * FROM articles WHERE id=?');
    const hits = rows
      .map(r => {
        const l2 = r.distance;
        const cos = Math.max(0, 1 - (l2 * l2) / 2);
        const art = artStmt.get(r.article_id);
        if (!art) return null;
        return { id: art.id, url: art.url, title: art.title, summary: art.summary, content: art.content, score: cos };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return hits;
  } catch (e) {
    console.error('[search-articles] failed:', e.message);
    return [];
  }
}
