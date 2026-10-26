// 8 类关系判定器 + 优先级短路 classify()
// 判定顺序：EQUIVALENT → CONTAINS → CONTRADICTS/PSEUDO_CONFLICT → VERSION → OVERLAPS → RELATED → UNRELATED
import { alignClaims, shareEntities } from './align.js';
import { llmAvailable } from '../pipeline/llm.js';

// 时间事实 slot 白名单（用于 VERSION 判定）
const TEMPORAL_SLOTS = new Set(['is', 'location', 'action', 'status', 'amount', 'ceo', 'price', 'policy', 'address']);

// 时间区间是否重叠
function timeOverlap(a, b) {
  const aFrom = a.valid_from || '';
  const aTo = a.valid_to || '';
  const bFrom = b.valid_from || '';
  const bTo = b.valid_to || '';
  // 任一为空 → 视为可能重叠（保守）
  if (!aFrom || !bFrom) return true;
  if (aFrom <= bTo && bFrom <= aTo) return true;
  return false;
}

// 条件/单位/口径是否不同（MVP：用 text_span 差异近似）
function qualifierDiffers(a, b) {
  if (a.valid_from !== b.valid_from) return 'time';
  if (a.valid_to !== b.valid_to) return 'time';
  // 来源不同
  if (a.source && b.source && a.source !== b.source) return 'source';
  return null;
}

// ---- 判定器 ----

/**
 * EQUIVALENT：等价重复
 * 信号：cos 高 + claim 对齐无冲突 + 极性一致
 */
function isEquivalent(A, B, cos) {
  if (cos < 0.88) return null;
  const align = alignClaims(A, B);
  // 有值冲突 → 不是等价
  if (align.conflicts.length) return null;
  // 双方都有 claim 且匹配数 > 0
  if (!align.matched.length) {
    // 单 claim 条目：直接比 cos + 极性
    if (A.length === 1 && B.length === 1) {
      if (A[0].polarity !== B[0].polarity) return null;
      if (cos >= 0.92) return { type: 'EQUIVALENT', subtype: 'paraphrase', confidence: Math.min(0.95, cos) };
    }
    return null;
  }
  // 极性一致
  for (const [a, b] of align.matched) {
    if (a.polarity !== b.polarity) return null;
  }
  // 独有 claim 极少（元数据差异）
  const extra = align.only_a.length + align.only_b.length;
  const total = A.length + B.length;
  if (total > 0 && extra / total > 0.3) return null;
  return {
    type: 'EQUIVALENT',
    subtype: cos >= 0.95 ? 'exact' : 'paraphrase',
    confidence: Math.min(0.95, cos * 0.5 + 0.5),
  };
}

/**
 * CONTAINS：包含/增量
 * 信号：claim 子集关系
 */
function isContains(A, B) {
  const align = alignClaims(A, B);
  if (align.conflicts.length) return null;
  const matched = align.matched.length;
  const onlyA = align.only_a.length;
  const onlyB = align.only_b.length;

  // A 包含 B：B 的所有 claim 都在 A 中找到，且 A 有独有
  if (onlyB === 0 && matched > 0 && onlyA > 0) {
    return { type: 'CONTAINS', subtype: 'superset', confidence: 0.82, direction: 'A_CONTAINS_B' };
  }
  // B 包含 A：A 的所有 claim 都在 B 中找到，且 B 有独有
  if (onlyA === 0 && matched > 0 && onlyB > 0) {
    return { type: 'CONTAINS', subtype: 'subset', confidence: 0.82, direction: 'B_CONTAINS_A' };
  }
  return null;
}

/**
 * 同槽位分歧：内部分流 VERSION / PSEUDO_CONFLICT / CONTRADICTS
 */
function classifySlotConflict(A, B) {
  const align = alignClaims(A, B);
  if (!align.conflicts.length) return null;

  for (const [a, b] of align.conflicts) {
    // 时间不同 → VERSION
    if (TEMPORAL_SLOTS.has(a.slot) && a.valid_from && b.valid_from && a.valid_from !== b.valid_from) {
      if (!timeOverlap(a, b)) {
        return { type: 'VERSION', subtype: 'temporal', confidence: 0.88 };
      }
    }
    // 版本不同
    if (a.value && b.value && /v\d+|version\s*\d+|第\d+版/i.test(a.value + b.value)) {
      return { type: 'VERSION', subtype: 'version_number', confidence: 0.85 };
    }
    // 可解释差异 → PSEUDO_CONFLICT
    const qd = qualifierDiffers(a, b);
    if (qd) {
      return { type: 'PSEUDO_CONFLICT', subtype: `${qd}_conflict`, confidence: 0.75 };
    }
    // 极性相反 → CONTRADICTS
    if (a.polarity !== b.polarity) {
      return { type: 'CONTRADICTS', subtype: 'polarity', confidence: 0.9 };
    }
    // 值冲突 → CONTRADICTS
    return { type: 'CONTRADICTS', subtype: 'value', confidence: 0.82 };
  }
  return null;
}

/**
 * OVERLAPS：部分重叠/互补
 */
function isOverlaps(A, B) {
  const align = alignClaims(A, B);
  if (align.conflicts.length) return null;
  const inter = align.matched.length;
  if (inter === 0) return null;
  if (align.only_a.length === 0 || align.only_b.length === 0) return null; // 是包含
  const total = inter + align.only_a.length + align.only_b.length;
  if (total === 0) return null;
  const ratio = inter / total;
  if (ratio >= 0.2) {
    return { type: 'OVERLAPS', subtype: 'complement', confidence: 0.7 + ratio * 0.2 };
  }
  return null;
}

/**
 * RELATED：相关
 */
function isRelated(A, B, cos) {
  if (cos < 0.50) return null;
  const shared = shareEntities(A, B);
  if (shared >= 1) {
    return { type: 'RELATED', subtype: 'shared_entity', confidence: 0.65 };
  }
  return null;
}

/**
 * 主入口：优先级短路判定
 * @param {Array} A 新条目 claims
 * @param {Array} B 候选条目 claims
 * @param {number} cos 条目级 cosine 相似度
 * @returns {{type, subtype, confidence, direction?}}
 */
export function classify(A, B, cos = 0) {
  // 1. EQUIVALENT
  const eq = isEquivalent(A, B, cos);
  if (eq) return eq;

  // 2. CONTAINS（子集关系稳定，先判）
  const ct = isContains(A, B);
  if (ct) return ct;

  // 3. OVERLAPS（部分重叠：有匹配 + 各有独有 + 无冲突 → 互补，不是矛盾）
  //    必须在 CONTRADICTS 之前判，否则"同 subject 不同 slot 的不同值"会被误判为矛盾
  const ov = isOverlaps(A, B);
  if (ov) return ov;

  // 4. 同槽位分歧（CONTRADICTS / PSEUDO_CONFLICT / VERSION）
  const sc = classifySlotConflict(A, B);
  if (sc) return sc;

  // 5. RELATED
  const rel = isRelated(A, B, cos);
  if (rel) return rel;

  // 6. UNRELATED
  return { type: 'UNRELATED', subtype: 'none', confidence: 1 - cos };
}

// 兼容旧 relation_type 映射
export function toLegacyType(newType) {
  switch (newType) {
    case 'EQUIVALENT': return 'merge';
    case 'CONTRADICTS': return 'conflict';
    case 'PSEUDO_CONFLICT': return 'conflict';
    default: return 'parallel';
  }
}

// 8 类类型常量
export const REL_TYPES = [
  'EQUIVALENT', 'CONTAINS', 'VERSION', 'CONTRADICTS',
  'PSEUDO_CONFLICT', 'OVERLAPS', 'RELATED', 'UNRELATED',
];
