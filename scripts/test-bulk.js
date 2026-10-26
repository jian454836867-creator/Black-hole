// 批量入库测试：1000 条短句 → 验证全部入库
import { heuristicInsights, MAX_INSIGHTS_PER_FILE } from '../src/pipeline/ingest.js';

const lines = [];
for (let i = 1; i <= 1000; i++) {
  lines.push(`第${i}条观点：概率思维要求用期望值评估第${i}个决策场景`);
}
const text = lines.join('\n');
const items = heuristicInsights(text);
console.log(`输入 1000 行短句，启发式提取: ${items.length} 条（上限 ${MAX_INSIGHTS_PER_FILE}）`);
console.log('首条:', items[0].content);
console.log('末条:', items[items.length - 1].content);
console.log(items.length === 1000 ? '✅ 1000 条全部提取' : '❌ 提取数量不符');
