// Step 1 验收：3 条不同维度 Query，断言召回正确 + 单次查询 < 500ms
import { search } from '../src/search/search.js';
import { embedder } from '../src/model/embedder.js';
import { getDb } from '../src/db/db.js';

const db = getDb();
const n = db.prepare('SELECT COUNT(*) n FROM insights').get().n;
console.log(`DB 中 insights 数量: ${n}`);
if (n < 20) {
  console.error('FAIL: 数据不足 20 条，请先运行 `npm run seed`');
  process.exit(1);
}

// 预热（不计入延迟）
console.log('预热模型...');
await embedder.warmup();

const TESTS = [
  {
    query: '苏轼被贬黄州时的心境',
    expect: ['苏轼被贬黄州时写下《赤壁赋》', '苏轼的「一蓑烟雨任平生」'],
    via: '语义',
  },
  {
    query: '微服务拆分的代价',
    expect: ['微服务拆分的代价是分布式事务', '微服务架构将单体拆分为独立部署'],
    via: '语义+领域术语',
  },
  {
    query: '苏轼',
    expect: ['苏轼被贬黄州时写下《赤壁赋》', '苏轼的「一蓑烟雨任平生」', '苏轼《江城子》悼念亡妻'],
    via: '专名关键词',
  },
];

let pass = true;
const latencies = [];

for (const t of TESTS) {
  const t0 = performance.now();
  const { hits, latencyMs } = await search(t.query, { k: 5 });
  latencies.push(latencyMs);
  const got = hits.map(h => {
    const row = db.prepare('SELECT i.content FROM insights i WHERE i.id=?').get(h.insightId);
    return row ? row.content : h.insightId;
  });
  const matched = t.expect.filter(e => got.some(g => g.includes(e.slice(0, 8))));
  const ok = matched.length >= Math.min(2, t.expect.length);
  if (!ok) pass = false;
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] Query: "${t.query}" (${t.via})`);
  console.log(`  延迟: ${latencyMs.toFixed(1)}ms (阈值 500ms)`);
  console.log(`  Top-${hits.length}:`);
  got.slice(0, 5).forEach((c, i) => console.log(`    ${i + 1}. [${hits[i].via} ${hits[i].score.toFixed(3)}] ${c.slice(0, 40)}${c.length > 40 ? '…' : ''}`));
  if (!ok) console.log(`  期望命中: ${t.expect.join(' | ')}`);
}

const median = latencies.slice().sort((a, b) => a - b)[Math.floor(latencies.length / 2)];
console.log(`\n--- 延迟统计 ---`);
console.log(`中位数: ${median.toFixed(1)}ms | 最大: ${Math.max(...latencies).toFixed(1)}ms`);
console.log(`延迟断言 (中位数 < 500ms): ${median < 500 ? 'PASS' : 'FAIL'}`);

embedder.stop();
console.log(pass && median < 500 ? '\n✅ STEP 1 验收通过' : '\n❌ STEP 1 验收未通过');
process.exit(pass && median < 500 ? 0 : 1);
