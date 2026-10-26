// 对比：短文本 vs 长文本 对同一查询的余弦相似度（bge-small-zh 短句退化诊断）
import { embedder } from '../src/model/embedder.js';

const queries = ['李白是什么风格'];
const targets = [
  '你好',
  '你好。',
  '你好，今天天气不错。',
  '你好，请问图书馆怎么走？我想找中文文学区，谢谢你的帮助。',
  '苏轼被贬黄州时写下赤壁赋，在困顿中寻求精神超脱。',
  '量子纠缠是量子力学中粒子间非局域关联现象。',
];

const qv = (await embedder.embed(queries))[0];
const tv = await embedder.embed(targets);
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

console.log('query:', queries[0]);
for (let i = 0; i < targets.length; i++) {
  console.log(`cos(${targets[i].slice(0, 20).padEnd(20, ' ')}) = ${cos(qv, tv[i]).toFixed(4)}`);
}
process.exit(0);
