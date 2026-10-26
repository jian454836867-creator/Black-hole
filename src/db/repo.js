import crypto from 'node:crypto';
import { getDb, nextRowId } from './db.js';

const uid = () => crypto.randomUUID();

export function insertRawFile({ privacyLevel = 'private', fileType, sourceUrl = null, rawText }) {
  const db = getDb();
  const id = uid();
  db.prepare(
    `INSERT INTO raw_files (id, privacy_level, file_type, source_url, raw_text) VALUES (?,?,?,?,?)`
  ).run(id, privacyLevel, fileType, sourceUrl, rawText);
  return id;
}

export function insertInsight({ content, summary = null, tags = [], sourceFileId = null, sourceUrl = null }) {
  const db = getDb();
  const id = uid();
  // 兼容旧库（无 source_url 列）
  try {
    db.prepare(
      `INSERT INTO insights (id, content, summary, tags, source_file_id, source_url) VALUES (?,?,?,?,?,?)`
    ).run(id, content, summary, JSON.stringify(tags), sourceFileId, sourceUrl);
  } catch {
    db.prepare(
      `INSERT INTO insights (id, content, summary, tags, source_file_id) VALUES (?,?,?,?,?)`
    ).run(id, content, summary, JSON.stringify(tags), sourceFileId);
  }
  const rowId = nextRowId(db);
  db.prepare('INSERT INTO insight_ids (rowid, insight_id) VALUES (?,?)').run(rowId, id);
  return { id, rowId };
}

export function attachVector(insightId, embedding) {
  const db = getDb();
  const rowId = db.prepare('SELECT rowid FROM insight_ids WHERE insight_id=?').get(insightId).rowid;
  db.prepare('INSERT INTO vec_insights (embedding) VALUES (?)').run(Float32Array.from(embedding));
}

export function getInsight(id) {
  return getDb().prepare('SELECT * FROM insights WHERE id=?').get(id) || null;
}

// ---------- 文章（链接整篇存储） ----------
export function insertArticle({ url, title = null, content, summary = null, topicTags = [] }) {
  const db = getDb();
  const id = uid();
  db.prepare(
    `INSERT INTO articles (id, url, title, content, summary, topic_tags, privacy_level) VALUES (?,?,?,?,?,'private',?)`
  ).run(id, url, title, content, summary, JSON.stringify(topicTags), new Date().toISOString().replace('T', ' ').slice(0, 19));
  return id;
}

export function getArticle(id) {
  return getDb().prepare('SELECT * FROM articles WHERE id=?').get(id) || null;
}

export function listArticles({ limit = 50 } = {}) {
  return getDb().prepare('SELECT * FROM articles ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function attachArticleVector(articleId, embedding) {
  const db = getDb();
  // article_ids 的 rowid 独立于 insight_ids
  const maxRow = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM article_ids').get().n;
  const maxVec = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM vec_articles').get().n;
  const rowId = Math.max(maxRow, maxVec) + 1;
  db.prepare('INSERT INTO article_ids (rowid, article_id) VALUES (?,?)').run(rowId, articleId);
  db.prepare('INSERT INTO vec_articles (embedding) VALUES (?)').run(Float32Array.from(embedding));
}

export function articleRelationsFor(articleId) {
  const db = getDb();
  return db.prepare(
    `SELECT r.*, a.url AS url_a, a.title AS title_a, b.url AS url_b, b.title AS title_b
     FROM article_relations r
     JOIN articles a ON a.id = r.article_a_id
     JOIN articles b ON b.id = r.article_b_id
     WHERE r.article_a_id = ? OR r.article_b_id = ?
     ORDER BY r.created_at DESC`
  ).all(articleId, articleId);
}

export function insertArticleRelation({ articleAId, articleBId, relationType, overlap, mergedArticleId = null }) {
  const db = getDb();
  const id = uid();
  db.prepare(
    `INSERT INTO article_relations (id, article_a_id, article_b_id, relation_type, overlap, merged_article_id) VALUES (?,?,?,?,?,?)`
  ).run(id, articleAId, articleBId, relationType, overlap, mergedArticleId);
  return id;
}

export function listInsights({ limit = 100 } = {}) {
  return getDb().prepare('SELECT * FROM insights ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function insertRelation({ insightAId, insightBId, relationType, explanation }) {
  const db = getDb();
  const id = uid();
  db.prepare(
    `INSERT INTO relations (id, insight_a_id, insight_b_id, relation_type, explanation, user_confirmed) VALUES (?,?,?,?,?,0)`
  ).run(id, insightAId, insightBId, relationType, explanation);
  return id;
}

export function relationsForInsight(insightId) {
  const db = getDb();
  return db.prepare(
    `SELECT r.*, a.content AS content_a, b.content AS content_b
     FROM relations r
     JOIN insights a ON a.id = r.insight_a_id
     JOIN insights b ON b.id = r.insight_b_id
     WHERE r.insight_a_id = ? OR r.insight_b_id = ?
     ORDER BY r.created_at DESC`
  ).all(insightId, insightId);
}

export function confirmRelation(id, state) {
  getDb().prepare('UPDATE relations SET user_confirmed=? WHERE id=?').run(state, id);
}

export function resetAll({ keepSeed = false } = {}) {
  const db = getDb();
  db.exec('DELETE FROM relations');
  db.exec('DELETE FROM claims');
  db.exec('DELETE FROM raw_files');
  db.exec('DELETE FROM articles');
  db.exec('DELETE FROM article_ids');
  db.exec('DELETE FROM article_relations');
  try { db.exec('DELETE FROM vec_articles'); } catch {}
  db.exec('DROP TRIGGER IF EXISTS ai_insights_ai');
  db.exec('DROP TRIGGER IF EXISTS ai_insights_ad');
  db.exec('DELETE FROM insights');
  db.exec('DELETE FROM insight_ids');
  db.exec('DROP TABLE IF EXISTS fts_insights');
  db.exec(`CREATE VIRTUAL TABLE fts_insights USING fts5(insight_id, content, tags, tokenize='unicode61')`);
  db.exec('DROP TABLE IF EXISTS vec_insights');
  db.exec('CREATE VIRTUAL TABLE vec_insights USING vec0(embedding float[512])');
  db.exec(`
    CREATE TRIGGER ai_insights_ai AFTER INSERT ON insights BEGIN
        INSERT INTO fts_insights(insight_id, content, tags)
        VALUES (new.id, new.content, COALESCE(new.tags, ''));
    END
  `);
  db.exec(`
    CREATE TRIGGER ai_insights_ad AFTER DELETE ON insights BEGIN
        INSERT INTO fts_insights(fts_insights, insight_id, content, tags)
        VALUES ('delete', old.id, old.content, COALESCE(old.tags, ''));
    END
  `);
  // keepSeed: 保留 20 条种子（仅 seed.js 用）；resetAll() 默认完全清空
  if (keepSeed) return { seeded: false };
  return { seeded: false };
}
