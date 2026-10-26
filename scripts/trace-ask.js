// 追踪 rag.ask 内部执行路径（手动复制逻辑，不用 import）
import { search } from '../src/search/search.js';

console.log('=== 直接调 search ===');
const { hits } = await search('李白是什么风格', { k: 5 });
console.log('hits:', hits.map(h => h.vec.toFixed(4)));

// 手动模拟 rag.js 的逻辑
const SIM_ABS_MIN = 0.35;
const SIM_REL_RATIO = 0.55;
const SIM_REL_FLOOR = 0.40;
const SIM_STRONG = 0.68;

const top1 = hits.length ? hits[0].vec : 0;
console.log('top1:', top1.toFixed(4));
const relFloor = Math.max(SIM_REL_FLOOR, SIM_REL_RATIO * top1);
console.log('relFloor:', relFloor.toFixed(4));
const goodHits = hits.filter(h => h.vec >= SIM_ABS_MIN && h.vec >= relFloor);
console.log('goodHits count:', goodHits.length);
console.log('top1 < SIM_STRONG?', top1 < SIM_STRONG, '=> should NO_KB:', top1 < SIM_STRONG);
process.exit(0);
