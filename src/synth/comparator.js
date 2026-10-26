// 合成引擎 · comparator v2：claim 级 8 类关系判定
// 替代旧版 cos 硬阈值三档（≥0.95 拒绝 / 0.82–0.95 归档 / <0.82 直接入库）
// 新流程：向量召回 top-K → claim 抽取 → claim 对齐 → 优先级短路判定 → 写关系边 + 更新条目状态
import crypto from 'node:crypto';
import { getDb } from '../db/db.js';
import { extractClaims, getCachedClaims } from '../rel/claims.js';
import { classify, REL_TYPES } from '../rel/classify.js';

export const SIM_THRESHOLD = 0.20;  // 向量召回阈值（放宽，让 claim 判定器做精细区分）
export const MAX_CANDIDATES = 20;  // 召回 top-K

// 向量召回候选（排除自身 + 排除已归档）
export function recallCandidates(insightId, { threshold = SIM_THRESHOLD, limit = MAX_CANDIDATES } = {}) {
  const db = getDb();
  const row = db.prepare('SELECT rowid FROM insight_ids WHERE insight_id=?').get(insightId);
  if (!row) return [];
  const vecRow = db.prepare('SELECT embedding FROM vec_insights WHERE rowid=?').get(row.rowid);
  if (!vecRow) return [];
  const rows = db.prepare(
    `SELECT rowid, distance FROM vec_insights WHERE embedding MATCH ? AND k = ? ORDER BY distance`
  ).all(Buffer.from(vecRow.embedding), limit + 1);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (r.rowid === row.rowid) continue;
    if (seen.has(r.rowid)) continue;
    seen.add(r.rowid);
    const l2 = r.distance;
    const cos = Math.max(0, 1 - (l2 * l2) / 2);
    if (cos < threshold) continue;
    const iid = db.prepare('SELECT insight_id FROM insight_ids WHERE rowid=?').get(r.rowid)?.insight_id;
    const ins = iid ? db.prepare('SELECT * FROM insights WHERE id=? AND archived=0').get(iid) : null;
    if (!ins) continue;
    out.push({ insight: ins, similarity: Math.round(cos * 10000) / 10000 });
  }
  return out.slice(0, limit);
}

// 是否已有关系记录
function hasRelation(db, aId, bId) {
  return db.prepare(
    `SELECT id FROM relations
     WHERE (insight_a_id=? AND insight_b_id=?) OR (insight_a_id=? AND insight_b_id=?)`
  ).get(aId, bId, bId, aId);
}

// 写关系边 + 更新条目状态
function writeRelation(db, { aId, bId, type, subtype, confidence, evidence, explanation }) {
  const relId = crypto.randomUUID();
  const evidenceJson = evidence ? JSON.stringify(evidence) : null;
  db.prepare(
    `INSERT INTO relations (id, insight_a_id, insight_b_id, relation_type, subtype, confidence, evidence, explanation, user_confirmed)
     VALUES (?,?,?,?,?,?,?,?,0)`
  ).run(relId, aId, bId, type, subtype || null, confidence, evidenceJson, explanation || '');
  return relId;
}

// 更新条目状态（逻辑失效，不物理删）
function updateEntryStatus(db, insightId, { status, validTo, relationGroupId, conflictFlag }) {
  const sets = [];
  const vals = [];
  if (status) { sets.push('status=?'); vals.push(status); }
  if (validTo) { sets.push('valid_to=?'); vals.push(validTo); }
  if (relationGroupId) { sets.push('relation_group_id=?'); vals.push(relationGroupId); }
  if (conflictFlag != null) { sets.push('conflict_flag=?'); vals.push(conflictFlag); }
  if (!sets.length) return;
  vals.push(insightId);
  db.prepare(`UPDATE insights SET ${sets.join(', ')} WHERE id=?`).run(...vals);
}

// 归档旧条目（删除向量/FTS，保留行）
function archiveOld(db, oldId, reason, newId) {
  db.prepare('UPDATE insights SET archived=1, archived_reason=? WHERE id=?').run(reason, oldId);
  const oldRow = db.prepare('SELECT rowid FROM insight_ids WHERE insight_id=?').get(oldId);
  if (oldRow) {
    db.prepare('DELETE FROM vec_insights WHERE rowid=?').run(oldRow.rowid);
    try { db.prepare('DELETE FROM fts_insights WHERE insight_id=?').run(oldId); } catch {}
  }
}

// 主入口：候选扫描 + claim 判定 + 关系落库
export async function compareNewInsight(insightId, { onRelation, includeSelf = false } = {}) {
  const db = getDb();
  const insight = db.prepare('SELECT * FROM insights WHERE id=?').get(insightId);
  if (!insight) return { insightId, candidates: 0, relations: [] };

  // 1. 向量召回
  const candidates = recallCandidates(insightId);
  console.error(`[synth-v2] ${insightId.slice(0, 8)}: ${candidates.length} 候选`);

  // 2. 新条目 claim 抽取
  const newClaims = await extractClaims(insightId, insight.content, insight.source_url || '');

  const created = [];
  const pairs = includeSelf
    ? candidates.map(c => [c.insight, c.similarity]).concat([[insight, 1.0]])
    : candidates.map(c => [c.insight, c.similarity]);

  for (const [other, cos] of pairs) {
    if (other.id === insight.id) continue;
    if (hasRelation(db, insightId, other.id)) continue;

    // 3. 候选 claim（缓存优先）
    const oldClaims = getCachedClaims(other.id) || await extractClaims(other.id, other.content, other.source_url || '');

    // 4. 优先级短路判定
    const verdict = classify(newClaims, oldClaims, cos);
    console.error(`[synth-v2] ${insightId.slice(0, 8)} ↔ ${other.id.slice(0, 8)}: ${verdict.type}(${verdict.subtype}) cos=${cos.toFixed(3)}`);

    // 5. 按类型执行动作
    const evidence = [insight.content.slice(0, 80), other.content.slice(0, 80)];
    switch (verdict.type) {
      case 'EQUIVALENT': {
        // 拒绝新条目 → 归档新条目（保留旧条目），合并 sources
        archiveOld(db, insightId, `等价重复（${verdict.subtype}，与 ${other.id.slice(0, 8)} cos=${cos.toFixed(3)}）`, other.id);
        writeRelation(db, {
          aId: insightId, bId: other.id,
          type: 'EQUIVALENT', subtype: verdict.subtype,
          confidence: verdict.confidence, evidence,
          explanation: `等价重复：${verdict.subtype}`,
        });
        break;
      }
      case 'CONTAINS': {
        // 新条目覆盖旧条目 → 旧条目 superseded
        if (verdict.direction === 'A_CONTAINS_B') {
          // 新(A) 包含 旧(B) → 旧被替代
          const groupId = crypto.randomUUID();
          updateEntryStatus(db, other.id, { status: 'superseded', relationGroupId: groupId });
          updateEntryStatus(db, insightId, { relationGroupId: groupId });
          archiveOld(db, other.id, `被包含/替代（新条目 ${insightId.slice(0, 8)} 包含旧信息）`, insightId);
        } else {
          // 旧(B) 包含 新(A) → 新被替代
          archiveOld(db, insightId, `被包含（旧条目 ${other.id.slice(0, 8)} 已包含新信息）`, other.id);
          updateEntryStatus(db, other.id, { status: 'active' });
        }
        writeRelation(db, {
          aId: insightId, bId: other.id,
          type: 'CONTAINS', subtype: verdict.subtype,
          confidence: verdict.confidence, evidence,
          explanation: `包含关系：${verdict.direction}`,
        });
        break;
      }
      case 'VERSION': {
        // 时间版本 → 旧条目 superseded + valid_to
        const groupId = crypto.randomUUID();
        updateEntryStatus(db, other.id, { status: 'superseded', validTo: new Date().toISOString().slice(0, 10), relationGroupId: groupId });
        updateEntryStatus(db, insightId, { relationGroupId: groupId });
        archiveOld(db, other.id, `版本更新（VERSION ${verdict.subtype}，新条目 ${insightId.slice(0, 8)}）`, insightId);
        writeRelation(db, {
          aId: insightId, bId: other.id,
          type: 'VERSION', subtype: verdict.subtype,
          confidence: verdict.confidence, evidence,
          explanation: `版本更新：${verdict.subtype}`,
        });
        break;
      }
      case 'CONTRADICTS': {
        // 真矛盾 → 双方都入库，标 conflict_flag
        const groupId = crypto.randomUUID();
        updateEntryStatus(db, insightId, { conflictFlag: 1, relationGroupId: groupId });
        updateEntryStatus(db, other.id, { conflictFlag: 1, relationGroupId: groupId });
        writeRelation(db, {
          aId: insightId, bId: other.id,
          type: 'CONTRADICTS', subtype: verdict.subtype,
          confidence: verdict.confidence, evidence,
          explanation: `真矛盾：${verdict.subtype}`,
        });
        break;
      }
      case 'PSEUDO_CONFLICT': {
        // 伪冲突 → 独立入库，写关系边（不标 conflict_flag）
        writeRelation(db, {
          aId: insightId, bId: other.id,
          type: 'PSEUDO_CONFLICT', subtype: verdict.subtype,
          confidence: verdict.confidence, evidence,
          explanation: `伪冲突：${verdict.subtype}（条件/口径/来源不同，双方都真）`,
        });
        break;
      }
      case 'OVERLAPS': {
        // 部分重叠 → 独立入库，建 relation_group
        const groupId = crypto.randomUUID();
        updateEntryStatus(db, insightId, { relationGroupId: groupId });
        updateEntryStatus(db, other.id, { relationGroupId: groupId });
        writeRelation(db, {
          aId: insightId, bId: other.id,
          type: 'OVERLAPS', subtype: verdict.subtype,
          confidence: verdict.confidence, evidence,
          explanation: `部分重叠/互补`,
        });
        break;
      }
      case 'RELATED': {
        // 相关 → 独立入库，写 RELATED 边
        writeRelation(db, {
          aId: insightId, bId: other.id,
          type: 'RELATED', subtype: verdict.subtype,
          confidence: verdict.confidence, evidence,
          explanation: `相关：${verdict.subtype}`,
        });
        break;
      }
      case 'UNRELATED':
      default:
        // 无关 → 独立入库，不写关系边
        break;
    }

    const rel = db.prepare(
      `SELECT * FROM relations WHERE insight_a_id=? AND insight_b_id=? ORDER BY created_at DESC LIMIT 1`
    ).get(insightId, other.id);
    if (rel) created.push({ relation: rel, verdict, similarity: cos });
    if (onRelation) onRelation(rel, cos);
  }

  return { insightId, candidates: candidates.length, relations: created };
}
