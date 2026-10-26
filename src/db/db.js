import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, '../../data');
export const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'black-hole.db');

let _db = null;

export function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  sqliteVec.load(db);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  // 迁移：旧库加新列/表
  try { db.exec('ALTER TABLE insights ADD COLUMN source_url TEXT'); } catch {}
  try { db.exec('ALTER TABLE insights ADD COLUMN archived INTEGER DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE insights ADD COLUMN archived_reason TEXT'); } catch {}
  // claim 级关系判定（8 类）：insights 加 status / valid_time / relation_group_id / conflict_flag
  try { db.exec(`ALTER TABLE insights ADD COLUMN status TEXT DEFAULT 'active'`); } catch {}
  try { db.exec(`ALTER TABLE insights ADD COLUMN valid_from TEXT`); } catch {}
  try { db.exec(`ALTER TABLE insights ADD COLUMN valid_to TEXT`); } catch {}
  try { db.exec(`ALTER TABLE insights ADD COLUMN relation_group_id TEXT`); } catch {}
  try { db.exec(`ALTER TABLE insights ADD COLUMN conflict_flag INTEGER DEFAULT 0`); } catch {}
  // relations 表加 subtype / confidence / evidence 列
  try { db.exec(`ALTER TABLE relations ADD COLUMN subtype TEXT`); } catch {}
  try { db.exec(`ALTER TABLE relations ADD COLUMN confidence REAL DEFAULT 0.8`); } catch {}
  try { db.exec(`ALTER TABLE relations ADD COLUMN evidence TEXT`); } catch {}
  // claims 表：claim 结构化抽取缓存
  db.exec(`
    CREATE TABLE IF NOT EXISTS claims (
      insight_id TEXT NOT NULL,
      subject TEXT,
      slot TEXT,
      value TEXT,
      polarity INTEGER DEFAULT 1,
      valid_from TEXT,
      valid_to TEXT,
      source TEXT,
      confidence REAL DEFAULT 1.0,
      text_span TEXT,
      PRIMARY KEY (insight_id, subject, slot, value)
    )
  `);
  // articles / article_ids / vec_articles / article_relations 由 schema.sql 的 IF NOT EXISTS 自动创建
  _db = db;
  return db;
}

export function nextRowId(db) {
  // insight_ids 与 vec_insights 的 rowid 必须一致（vec 无显式 PK 列）
  const a = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM insight_ids').get().n;
  const b = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM vec_insights').get().n;
  return Math.max(a, b) + 1;
}
