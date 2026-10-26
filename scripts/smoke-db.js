import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const db = new Database(':memory:');
sqliteVec.load(db);
console.log('sqlite-vec loaded, version:', db.prepare('SELECT vec_version()').get());

db.exec(`CREATE VIRTUAL TABLE t USING vec0(v float[4])`);
db.prepare('INSERT INTO t (v) VALUES(?)').run(new Float32Array([1, 2, 3, 4]));
db.prepare('INSERT INTO t (v) VALUES(?)').run(new Float32Array([4, 3, 2, 1]));
const rows = db.prepare('SELECT rowid, distance FROM t WHERE v MATCH ? ORDER BY distance LIMIT 1').all(new Float32Array([1, 1, 1, 1]));
console.log('vec knn ok:', JSON.stringify(rows));

db.exec(`CREATE VIRTUAL TABLE f USING fts5(content)`);
db.prepare('INSERT INTO f VALUES (?)').run('苏轼 黄州 赤壁');
console.log('fts5 ok:', JSON.stringify(db.prepare("SELECT content FROM f WHERE f MATCH '苏轼'").all()));
console.log('SMOKE PASS');
