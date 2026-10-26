// 消息价值过滤测试（bge 短句退化校准版）
import { isValuable } from '../src/pipeline/filter.js';

const CASES = [
  // [输入, 期望有价值?]
  ['你好', false],
  ['在吗', false],
  ['hello', false],
  ['hi', false],
  ['好的', false],
  ['嗯嗯', false],
  ['！！！！', false],
  ['李白', false],                    // 2 字，无主题上下文
  ['苏轼', false],                    // 2 字，太短
  ['量子纠缠', true],                 // 4 字但含主题词"量子纠缠"
  ['沉没成本是什么', true],            // 7 字但含主题词"沉没成本"
  ['苏轼的黄州经历', false],           // 7 字，人名不算主题词
  ['微服务拆分的代价', true],          // 8 字含主题词
  ['写作是与自己对话', false],         // 7 字无主题词 → 不入库（短句退化）
  ['对话不是轮流独白。', false],        // 8 字无主题词
  ['【二、知识与真理】', false],        // 5 字
  ['你好你好你好', false],
  ['hello world this is a test message', true],  // 5 英文单词
  ['   ', false],
  ['ok', false],
  ['明白了', false],
  // 12 字以上正常入库
  ['写作是与自己的一场深度对话。', true],  // 13 字
  ['好的我理解了你的意思。', false],       // 10 字无主题词 → 过滤
];

let pass = 0, fail = 0;
for (const [input, expect] of CASES) {
  const r = isValuable(input);
  const ok = r.valuable === expect;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✅' : '❌'} "${input}" → valuable=${r.valuable} (${r.reason || '通过'}) 期望=${expect}`);
}
console.log(`\n${pass}/${pass + fail} 通过${fail ? ' ❌' : ' ✅'}`);
process.exit(fail ? 1 : 0);
