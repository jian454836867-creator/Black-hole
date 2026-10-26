// smoke test: claim 抽取 + 对齐 + 8 类判定
import { ruleExtractClaims } from '../src/rel/claims.js';
import { alignClaims } from '../src/rel/align.js';
import { classify } from '../src/rel/classify.js';

let passed = 0, failed = 0;
function assert(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

console.log('=== 1. 规则 claim 抽取 ===');
const c1 = ruleExtractClaims('我老板是罗永浩', 'test');
console.log('  "我老板是罗永浩" →', JSON.stringify(c1));
assert('抽到 subject=老板', c1.some(c => c.subject.includes('老板')));
assert('抽到 value=罗永浩', c1.some(c => c.value === '罗永浩'));

const c2 = ruleExtractClaims('罗永浩在深圳摆地摊', 'test');
console.log('  "罗永浩在深圳摆地摊" →', JSON.stringify(c2));
assert('抽到 location slot（值含深圳）', c2.some(c => c.slot === 'location' && c.value.includes('深圳')));

const c3 = ruleExtractClaims('罗永浩2024年去了北京', 'test');
console.log('  "罗永浩2024年去了北京" →', JSON.stringify(c3));
assert('抽到时间 valid_from=2024', c3.some(c => c.valid_from && c.valid_from.startsWith('2024')));

const c4 = ruleExtractClaims('罗永浩花了10亿元', 'test');
console.log('  "罗永浩花了10亿元" →', JSON.stringify(c4));
assert('数值归一 10亿→1000000000', c4.some(c => c.slot === 'amount' && c.value === '1000000000'));

console.log('\n=== 2. claim 对齐 ===');
// 等价：同 subject+slot+value
const A1 = [{ subject: '罗永浩', slot: 'is', value: '深圳人', polarity: 1 }];
const B1 = [{ subject: '罗永浩', slot: 'is', value: '深圳人', polarity: 1 }];
const align1 = alignClaims(A1, B1);
console.log('  等价对 → matched:', align1.matched.length, 'conflicts:', align1.conflicts.length);
assert('匹配 1 对', align1.matched.length === 1);
assert('无冲突', align1.conflicts.length === 0);

// 冲突：同 subject+slot 不同 value
const A2 = [{ subject: '罗永浩', slot: 'location', value: '深圳', polarity: 1 }];
const B2 = [{ subject: '罗永浩', slot: 'location', value: '北京', polarity: 1 }];
const align2 = alignClaims(A2, B2);
console.log('  冲突对 → conflicts:', align2.conflicts.length);
assert('检测到 1 个冲突', align2.conflicts.length === 1);

// 包含：A 有 B 的所有 claim + 额外 claim
const A3 = [
  { subject: '罗永浩', slot: 'location', value: '深圳', polarity: 1 },
  { subject: '罗永浩', slot: 'action', value: '摆地摊', polarity: 1 },
];
const B3 = [{ subject: '罗永浩', slot: 'location', value: '深圳', polarity: 1 }];
const align3 = alignClaims(A3, B3);
console.log('  包含对 → matched:', align3.matched.length, 'only_a:', align3.only_a.length, 'only_b:', align3.only_b.length);
assert('匹配 1 对', align3.matched.length === 1);
assert('A 独有 1 条', align3.only_a.length === 1);
assert('B 无独有', align3.only_b.length === 0);

console.log('\n=== 3. 8 类判定 ===');
// EQUIVALENT：高 cos + 完全匹配
const eq = classify(
  [{ subject: '罗永浩', slot: 'is', value: '深圳人', polarity: 1 }],
  [{ subject: '罗永浩', slot: 'is', value: '深圳人', polarity: 1 }],
  0.95
);
console.log('  等价 →', eq.type, eq.subtype);
assert('判为 EQUIVALENT', eq.type === 'EQUIVALENT');

// CONTAINS：子集关系
const ct = classify(
  [
    { subject: '罗永浩', slot: 'location', value: '深圳', polarity: 1 },
    { subject: '罗永浩', slot: 'action', value: '摆地摊', polarity: 1 },
  ],
  [{ subject: '罗永浩', slot: 'location', value: '深圳', polarity: 1 }],
  0.80
);
console.log('  包含 →', ct.type, ct.subtype, ct.direction);
assert('判为 CONTAINS', ct.type === 'CONTAINS');

// CONTRADICTS：同 slot 不同 value
const cd = classify(
  [{ subject: '罗永浩', slot: 'location', value: '深圳', polarity: 1 }],
  [{ subject: '罗永浩', slot: 'location', value: '北京', polarity: 1 }],
  0.75
);
console.log('  矛盾 →', cd.type, cd.subtype);
assert('判为 CONTRADICTS', cd.type === 'CONTRADICTS');

// VERSION：同 slot 不同 value + 不同时间
const vr = classify(
  [{ subject: '罗永浩', slot: 'location', value: '北京', polarity: 1, valid_from: '2024-01-01', valid_to: null }],
  [{ subject: '罗永浩', slot: 'location', value: '深圳', polarity: 1, valid_from: '2023-01-01', valid_to: null }],
  0.70
);
console.log('  版本 →', vr.type, vr.subtype);
assert('判为 VERSION', vr.type === 'VERSION');

// PSEUDO_CONFLICT：同 slot 不同 value + 来源不同
const pc = classify(
  [{ subject: '罗永浩', slot: 'location', value: '北京', polarity: 1, source: '微博' }],
  [{ subject: '罗永浩', slot: 'location', value: '深圳', polarity: 1, source: '抖音' }],
  0.72
);
console.log('  伪冲突 →', pc.type, pc.subtype);
assert('判为 PSEUDO_CONFLICT', pc.type === 'PSEUDO_CONFLICT');

// OVERLAPS：部分重叠（不同 slot → 不触发 conflict → 走 OVERLAPS）
// 注意：同 slot 不同 value 会走 CONTRADICTS（规则层正确行为）；
// LLM 抽 claim 时"摆地摊"和"开奶茶店"会抽成不同 slot 才走 OVERLAPS
const ov = classify(
  [
    { subject: '罗永浩', slot: 'location', value: '深圳', polarity: 1 },
    { subject: '罗永浩', slot: 'business', value: '摆地摊', polarity: 1 },
  ],
  [
    { subject: '罗永浩', slot: 'location', value: '深圳', polarity: 1 },
    { subject: '罗永浩', slot: 'business', value: '开奶茶店', polarity: 1 },
  ],
  0.65
);
console.log('  重叠(不同slot) →', ov.type, ov.subtype);
// 同 slot(business) 不同 value → 规则层判 CONTRADICTS（LLM 可用时不同 slot 走 OVERLAPS）
assert('同 slot 不同 value → CONTRADICTS（规则层预期）', ov.type === 'CONTRADICTS');

// OVERLAPS 真实 case：匹配 + 各自独有 + 无冲突（不同 slot 且不同 value 不算 conflict 当 slot 不同时）
const ov2 = classify(
  [
    { subject: '罗永浩', slot: 'location', value: '深圳', polarity: 1 },
    { subject: '罗永浩', slot: 'business', value: '摆地摊', polarity: 1 },
  ],
  [
    { subject: '罗永浩', slot: 'location', value: '深圳', polarity: 1 },
    { subject: '罗永浩', slot: 'other', value: '开奶茶店', polarity: 1 },
  ],
  0.65
);
console.log('  重叠(跨slot) →', ov2.type, ov2.subtype);
assert('跨 slot 部分重叠 → OVERLAPS', ov2.type === 'OVERLAPS');

// RELATED：共享 subject + 中 cos + 无 claim 匹配（完全不同 slot）
const rel = classify(
  [{ subject: '罗永浩', slot: 'action', value: '摆地摊', polarity: 1 }],
  [{ subject: '罗永浩', slot: 'status', value: '很成功', polarity: 1 }],
  0.55
);
console.log('  相关 →', rel.type, rel.subtype);
// 无匹配（slot 不同）+ 无冲突 + 共享 subject + cos>=0.50 → RELATED
assert('共享 subject 无匹配 → RELATED', rel.type === 'RELATED');

// UNRELATED：无共享 + 低 cos
const un = classify(
  [{ subject: '李白', slot: 'is', value: '诗人', polarity: 1 }],
  [{ subject: '苏轼', slot: 'is', value: '词人', polarity: 1 }],
  0.30
);
console.log('  无关 →', un.type);
assert('判为 UNRELATED', un.type === 'UNRELATED');

// 极性矛盾
const pol = classify(
  [{ subject: '罗永浩', slot: 'is', value: '好人', polarity: 1 }],
  [{ subject: '罗永浩', slot: 'is', value: '好人', polarity: -1 }],
  0.90
);
console.log('  极性矛盾 →', pol.type, pol.subtype);
// 极性矛盾：同 slot 同 value 但 polarity 不同 → 不会进 matched（因为 valuesEqual 不检查 polarity）
// 实际上 polarity 不同但 value 相同 → valuesEqual 返回 true → 进 matched → isEquivalent 检查 polarity → null
// 然后 CONTAINS → 不满足 → classifySlotConflict → 无 conflicts → OVERLAPS/RELATED/UNRELATED
// 这个 case 需要特殊处理：polarity 不同应该进 conflicts
assert('极性矛盾 → CONTRADICTS', pol.type === 'CONTRADICTS');

console.log(`\n=== 结果：${passed} 通过, ${failed} 失败 ===`);
process.exit(failed > 0 ? 1 : 0);
