// DB 迁移 + 模块加载验证
import { getDb } from '../src/db/db.js';
const db = getDb();

const cols = db.prepare('PRAGMA table_info(insights)').all().map(c => c.name);
console.log('insights cols:', cols.join(', '));
console.log('status:', cols.includes('status') ? 'OK' : 'MISSING');
console.log('relation_group_id:', cols.includes('relation_group_id') ? 'OK' : 'MISSING');
console.log('conflict_flag:', cols.includes('conflict_flag') ? 'OK' : 'MISSING');

const relCols = db.prepare('PRAGMA table_info(relations)').all().map(c => c.name);
console.log('relations cols:', relCols.join(', '));
console.log('subtype:', relCols.includes('subtype') ? 'OK' : 'MISSING');
console.log('confidence:', relCols.includes('confidence') ? 'OK' : 'MISSING');
console.log('evidence:', relCols.includes('evidence') ? 'OK' : 'MISSING');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='claims'").all();
console.log('claims table:', tables.length ? 'OK' : 'MISSING');

// 模块加载
const { extractClaims, ruleExtractClaims } = await import('../src/rel/claims.js');
const { alignClaims } = await import('../src/rel/align.js');
const { classify } = await import('../src/rel/classify.js');
const { compareNewInsight, recallCandidates } = await import('../src/synth/comparator.js');
const { search } = await import('../src/search/search.js');
const { ingest } = await import('../src/pipeline/ingest.js');
console.log('All modules loaded: OK');
process.exit(0);
