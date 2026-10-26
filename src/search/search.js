// search(query): 双路召回 + 关系聚合
// 向量 Top-K ∥ FTS5 Top-K → 7:3 加权融合 → 按关系边聚合（折叠等价/版本取 active/冲突并列）
import { getDb } from '../db/db.js';
import { embedder } from '../model/embedder.js';

const W_VEC = 0.7;
const W_FTS = 0.3;

function toFtsMatch(query) {
  const q = query.trim();
  if (!q) return null;
  const parts = [];
  parts.push(`"${q.replace(/"/g, '""')}"`);
  const cjk = q.replace(/[^\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(s => s.length >= 2);
  const grams = new Set();
  for (const s of cjk) for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
  const gramTokens = [...grams].map(g => `"${g.replace(/"/g, '""')}"`);
  if (gramTokens.length) parts.push('(' + gramTokens.join(' AND ') + ')');
  return parts.join(' OR ');
}

function normalizeFts(rows) {
  if (!rows.length) return new Map();
  const vals = rows.map(r => r.score);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const m = new Map();
  for (const r of rows) m.set(r.insightId, (r.score - min) / range);
  return m;
}

/**
 * 关系聚合：对召回结果按 relation_group_id 折叠
 * - EQUIVALENT: 只保留一条（最高分），其余折叠
 * - VERSION: 只保留 active 的
 * - CONTRADICTS: 并列展示，标 conflict_flag
 * - CONTAINS: 取父（active），子作证据
 * - OVERLAPS: 聚类，取最高分
 * - RELATED/UNRELATED: 不折叠
 */
function aggregateByRelations(db, hits) {
  if (!hits.length) return hits;
  const insStmt = db.prepare('SELECT id, status, relation_group_id, conflict_flag, content FROM insights WHERE id=?');
  const relStmt = db.prepare(
    `SELECT r.relation_type, r.insight_a_id, r.insight_b_id
     FROM relations r
     WHERE (r.insight_a_id=? OR r.insight_b_id=?) AND r.user_confirmed != -1`
  );

  // 收集所有命中的关系组
  const groupMap = new Map(); // groupId -> [hit, ...]
  const noGroup = [];

  for (const h of hits) {
    const row = insStmt.get(h.insightId);
    if (!row) { noGroup.push(h); continue; }
    h._status = row.status || 'active';
    h._conflictFlag = row.conflict_flag || 0;
    h._groupId = row.relation_group_id || null;

    if (h._groupId) {
      if (!groupMap.has(h._groupId)) groupMap.set(h._groupId, []);
      groupMap.get(h._groupId).push(h);
    } else {
      noGroup.push(h);
    }
  }

  const out = [...noGroup];

  for (const [groupId, groupHits] of groupMap) {
    if (groupHits.length === 1) { out.push(groupHits[0]); continue; }

    // 查这个组内的关系类型
    const types = new Set();
    for (const h of groupHits) {
      const rels = relStmt.all(h.insightId, h.insightId);
      for (const r of rels) {
        // 只取组内的关系
        const otherId = r.insight_a_id === h.insightId ? r.insight_b_id : r.insight_a_id;
        if (groupHits.some(g => g.insightId === otherId)) {
          types.add(r.relation_type);
        }
      }
    }

    if (types.has('EQUIVALENT')) {
      // 折叠：只保留最高分
      const best = groupHits.reduce((a, b) => a.score >= b.score ? a : b);
      best._collapsed = groupHits.length - 1;
      out.push(best);
    } else if (types.has('VERSION')) {
      // 版本：只保留 active
      const active = groupHits.filter(h => h._status === 'active');
      const chosen = active.length ? active : groupHits;
      const best = chosen.reduce((a, b) => a.score >= b.score ? a : b);
      best._versionGroup = groupHits.length;
      out.push(best);
    } else if (types.has('CONTRADICTS')) {
      // 冲突：并列展示
      for (const h of groupHits) {
        h._conflict = true;
        out.push(h);
      }
    } else if (types.has('CONTAINS')) {
      // 包含：取 active
      const active = groupHits.filter(h => h._status === 'active');
      const chosen = active.length ? active : groupHits;
      const best = chosen.reduce((a, b) => a.score >= b.score ? a : b);
      out.push(best);
    } else if (types.has('OVERLAPS')) {
      // 重叠：取最高分
      const best = groupHits.reduce((a, b) => a.score >= b.score ? a : b);
      out.push(best);
    } else {
      // RELATED/UNRELATED: 不折叠
      out.push(...groupHits);
    }
  }

  return out.sort((a, b) => b.score - a.score);
}

export async function search(query, { k = 5 } = {}) {
  const db = getDb();
  const t0 = performance.now();

  const [vecRows, ftsRows] = await Promise.all([
    (async () => {
      try {
        const [qvec] = await embedder.embed([query]);
        const qf = Float32Array.from(qvec);
        const rows = db.prepare(
          `SELECT m.rowid, m.distance FROM vec_insights AS m WHERE m.embedding MATCH ? AND m.k = ? ORDER BY m.distance ASC`
        ).all(qf, k * 3);
        const idStmt = db.prepare('SELECT insight_id FROM insight_ids WHERE rowid=?');
        return rows
          .map(r => {
            const row = idStmt.get(r.rowid);
            if (!row) return null;
            const l2 = r.distance;
            const cos = Math.max(0, 1 - (l2 * l2) / 2);
            return { insightId: row.insight_id, cos, l2 };
          })
          .filter(Boolean);
      } catch (e) {
        console.error('[search] vec path failed:', e.message);
        return [];
      }
    })(),
    (async () => {
      const match = toFtsMatch(query);
      if (!match) return [];
      try {
        const rows = db.prepare(
          `SELECT insight_id, bm25(fts_insights) AS score
           FROM fts_insights
           WHERE fts_insights MATCH ?
           LIMIT ?`
        ).all(match, k * 3);
        return rows.map(r => ({ insightId: r.insight_id, bm25: r.score }));
      } catch { return []; }
    })(),
  ]);

  const ftsNorm = normalizeFts(ftsRows);

  const merged = new Map();
  for (const r of vecRows) {
    merged.set(r.insightId, { insightId: r.insightId, vec: r.cos, fts: 0, via: 'vec' });
  }
  for (const [id, fts] of ftsNorm) {
    const e = merged.get(id) || { insightId: id, vec: 0, fts: 0, via: 'fts' };
    e.fts = fts;
    e.via = e.via === 'vec' ? 'both' : e.via;
    merged.set(id, e);
  }

  // 排除已归档 + 已替代（superseded）
  const archStmt = db.prepare("SELECT id FROM insights WHERE archived = 1 OR status = 'superseded'");
  const excludedSet = new Set(archStmt.all().map(r => r.id));

  let hits = [...merged.values()]
    .filter(e => !excludedSet.has(e.insightId))
    .map(e => ({
      insightId: e.insightId,
      vec: e.vec,
      score: e.vec,
      fts: e.fts,
      via: e.via,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k * 2); // 多召回一些给聚合用

  // 关系聚合
  hits = aggregateByRelations(db, hits).slice(0, k);

  return { hits, latencyMs: performance.now() - t0 };
}
