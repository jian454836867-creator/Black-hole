// claim 对齐：对 (new_claims, cand_claims) 做 subject+slot 匹配 + value 比较
// 输出 Alignment: { matched, only_a, only_b, conflicts }
//   matched:   [[a, b], ...]  — subject+slot 相同且 value 相等
//   only_a:    [a, ...]       — A 独有
//   only_b:    [b, ...]       — B 独有
//   conflicts: [[a, b], ...]  — subject+slot 相同但 value 不同

// slot 同义词表
const SLOT_SYNONYMS = {
  is: ['is', 'name', '身份', '角色'],
  location: ['location', 'place', '地点', '位置', '地址'],
  action: ['action', 'event', '动作', '事件', '行为'],
  amount: ['amount', 'price', 'money', '价格', '金额', '成本'],
  status: ['status', 'state', '状态', '情况'],
  desc: ['desc', 'other', '描述', '其他'],
};

function slotSim(a, b) {
  if (a === b) return 1;
  const ga = SLOT_SYNONYMS[a] || [a];
  const gb = SLOT_SYNONYMS[b] || [b];
  if (ga.some(s => gb.includes(s))) return 1;
  // 字符级模糊
  const setA = new Set(a);
  let n = 0;
  for (const ch of b) if (setA.has(ch)) n++;
  return n / Math.max(1, Math.min(a.length, b.length));
}

// 值相等判定（含数值容差）
function valuesEqual(a, b) {
  const sa = String(a).trim();
  const sb = String(b).trim();
  if (sa === sb) return true;
  // 数值容差
  const na = parseFloat(sa);
  const nb = parseFloat(sb);
  if (!isNaN(na) && !isNaN(nb)) {
    const diff = Math.abs(na - nb);
    const base = Math.max(Math.abs(na), Math.abs(nb), 1);
    if (diff / base < 0.02) return true; // 2% 容差
  }
  return false;
}

/**
 * 对齐两组 claims
 * @param {Array} A 新条目的 claims
 * @param {Array} B 候选条目的 claims
 * @returns {{matched, only_a, only_b, conflicts}}
 */
export function alignClaims(A, B) {
  const matched = [];
  const only_a = [...A];
  const only_b = [...B];
  const conflicts = [];
  const bUsed = new Set();

  for (const a of A) {
    // 找 B 中同 subject + 同 slot 的最佳匹配
    let best = null;
    let bestSim = 0;
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (bUsed.has(i)) continue;
      if (a.subject !== b.subject) continue;
      const s = slotSim(a.slot, b.slot);
      if (s >= 0.8 && s > bestSim) {
        best = i;
        bestSim = s;
      }
    }
    if (best !== null) {
      const b = B[best];
      bUsed.add(best);
      const bIdx = only_b.indexOf(b);
      if (bIdx >= 0) only_b.splice(bIdx, 1);
      if (valuesEqual(a.value, b.value) && a.polarity === b.polarity) {
        matched.push([a, b]);
        const aIdx = only_a.indexOf(a);
        if (aIdx >= 0) only_a.splice(aIdx, 1);
      } else {
        // value 不同或 polarity 不同 → 冲突
        conflicts.push([a, b]);
        const aIdx = only_a.indexOf(a);
        if (aIdx >= 0) only_a.splice(aIdx, 1);
      }
    }
  }

  for (let i = 0; i < B.length; i++) {
    if (!bUsed.has(i)) {
      // 已经在 only_b 里
    }
  }

  return { matched, only_a, only_b, conflicts };
}

/**
 * 检查两组 claims 是否有共享 subject
 */
export function shareEntities(A, B) {
  const setA = new Set(A.map(c => c.subject));
  let n = 0;
  for (const b of B) if (setA.has(b.subject)) n++;
  return n;
}
