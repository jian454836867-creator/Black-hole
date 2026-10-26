// claim 结构化抽取：LLM 优先 + 规则兜底
// 输出 Claim[]: { subject, slot, value, polarity, valid_from, valid_to, source, confidence, text_span }
import { getDb } from '../db/db.js';
import { _chat, llmAvailable } from '../pipeline/llm.js';

const FLASH_MODEL = 'deepseek-chat';

// 实体别名归一表（可扩展）
const ALIAS_MAP = {
  '罗永浩': '罗永浩', '老罗': '罗永浩', 'Luo Yonghao': '罗永浩',
  '深圳': '深圳', 'sz': '深圳', 'SZ': '深圳',
};

// 时间表达 → ISO 日期（简单规则）
const TIME_PATTERNS = [
  { re: /(\d{4})年(\d{1,2})月(\d{1,2})日/, type: 'full' },
  { re: /(\d{4})年(\d{1,2})月/, type: 'month' },
  { re: /(\d{4})年/, type: 'year' },
  { re: /(\d{4})-(\d{2})-(\d{2})/, type: 'iso' },
  { re: /(\d{4})-(\d{2})/, type: 'iso_month' },
];

function extractTime(text) {
  for (const { re, type } of TIME_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const y = m[1];
      const mo = (m[2] || '01').padStart(2, '0');
      const d = (m[3] || '01').padStart(2, '0');
      return {
        valid_from: `${y}-${mo}-${d}`,
        valid_to: type === 'full' || type === 'iso' ? `${y}-${mo}-${d}` : null,
      };
    }
  }
  return { valid_from: null, valid_to: null };
}

// 数值归一："10亿" → 1e9, "3.5万" → 35000
function normalizeValue(val) {
  if (val == null) return '';
  const s = String(val).trim();
  const m = s.match(/^([\d.]+)\s*(亿|万|千|百)$/);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = { '亿': 1e8, '万': 1e4, '千': 1e3, '百': 100 }[m[2]];
    return String(n * unit);
  }
  // 纯数字去千分位
  const num = s.replace(/,/g, '');
  if (/^\d+\.?\d*$/.test(num)) return num;
  // 实体别名归一
  return ALIAS_MAP[s] || s.toLowerCase();
}

// 极性检测
function detectPolarity(text) {
  const neg = /不|没|未|无|非|别|莫|勿|没有|不是|无法|不能/.test(text);
  return neg ? -1 : 1;
}

/**
 * 规则抽取（无 LLM 时的降级）
 * 从一句中文短句里抽 subject/slot/value
 */
export function ruleExtractClaims(text, source = '') {
  const t = text.trim();
  const polarity = detectPolarity(t);
  const time = extractTime(t);
  const claims = [];

  // 模式 1: "X 是 Y" / "X 叫 Y" / "X 为 Y"
  const isMatch = t.match(/^(.{2,15}?)[，,]?\s*(?:是|叫|为|叫作|叫做|名叫|名为|担任|出任|当|成为|变成|改名为)\s*(.{1,30})[。.!！]?\s*$/);
  if (isMatch) {
    const subject = normalizeValue(isMatch[1].replace(/^我|他|她|它/, '').replace(/\d{4}年?$/, '').trim());
    const slot = 'is';
    const value = normalizeValue(isMatch[2]);
    claims.push({
      subject, slot, value, polarity,
      valid_from: time.valid_from, valid_to: time.valid_to,
      source, confidence: 0.7, text_span: t,
    });
  }

  // 模式 2: "X 在 Y（地方）" / "X 去 Y"（值去掉前缀动词 了/到/在；地点后跟动作时截断）
  const locMatch = t.match(/^(.{2,15}?)[，,]?\s*(?:在|去|到|来到|搬到|住在|位于|去了|去到)\s*([\u4e00-\u9fff]{2,8}?)(?=[。.!！]|(?:摆|开|做|搞|卖|卖货|摆摊|开店|开摊|住|工作|生活)|$)\s*$/);
  if (locMatch) {
    const subject = normalizeValue(locMatch[1].replace(/\d{4}年?$/, '').trim());
    let val = locMatch[2].replace(/^[了到去在来]/, '');
    const value = normalizeValue(val);
    claims.push({
      subject, slot: 'location', value, polarity,
      valid_from: time.valid_from, valid_to: time.valid_to,
      source, confidence: 0.7, text_span: t,
    });
  }

  // 模式 3: "X 做了 Y" / "X 开始 Y" / "X 宣布 Y"
  const actMatch = t.match(/^(.{2,15}?)[，,]?\s*(?:开始|宣布|决定|选择|打算|计划|决定|宣布|开始|进行|启动|推出|发布|上线|开业|开张|摆摊|开店|做|搞|搞了)\s*(.{2,30})[。.!！]?\s*$/);
  if (actMatch) {
    const subject = normalizeValue(actMatch[1].replace(/\d{4}年?$/, '').trim());
    let val = actMatch[2].replace(/^[了到去在来开始宣布决定]/, '');
    const value = normalizeValue(val);
    claims.push({
      subject, slot: 'action', value, polarity,
      valid_from: time.valid_from, valid_to: time.valid_to,
      source, confidence: 0.65, text_span: t,
    });
  }

  // 模式 4: 数值相关 "X 有/值/约/成本 Y 元/万/亿"
  const numMatch = t.match(/^(.{2,15}?)[，,]?\s*(?:有|值|约|成本|花了|赚了|亏了|收入|价格|定价|售价|收费)\s*([\d.]+[万亿千百]?)\s*(?:[元块刀块钱]?)\s*[。.!！]?\s*$/);
  if (numMatch) {
    const subject = normalizeValue(numMatch[1].replace(/\d{4}年?$/, '').trim());
    const value = normalizeValue(numMatch[2]);
    claims.push({
      subject, slot: 'amount', value, polarity,
      valid_from: time.valid_from, valid_to: time.valid_to,
      source, confidence: 0.75, text_span: t,
    });
  }

  // 兜底：整句作为一个 claim（subject=首实体, slot='desc', value=整句）
  if (!claims.length) {
    // 取前 2-4 个字做 subject 猜测
    const subj = t.slice(0, Math.min(4, Math.max(2, Math.floor(t.length / 3))));
    claims.push({
      subject: normalizeValue(subj), slot: 'desc', value: t, polarity,
      valid_from: time.valid_from, valid_to: time.valid_to,
      source, confidence: 0.4, text_span: t,
    });
  }

  return claims;
}

/**
 * LLM 抽取（有 DeepSeek Key 时）
 * 输出结构化 claim 列表
 */
export async function llmExtractClaims(text, source = '') {
  const system = `你是 claim 抽取器。从一句中文文本中抽取结构化 claim。
每个 claim 包含：
- subject: 主体实体（人名/事物名，归一化，去"我/他/她"等代词）
- slot: 属性/谓词（如 is/location/action/amount/status/other）
- value: 值（归一化：数字统一单位，日期 ISO 格式）
- polarity: 1 肯定 / -1 否定
- valid_from: 生效起始日期（ISO 或空字符串）
- valid_to: 失效日期（ISO 或空字符串）
只输出 JSON 数组，不要输出其它内容。
格式：[{"subject":"...","slot":"...","value":"...","polarity":1,"valid_from":"","valid_to":"","text_span":"原文片段"}]`;
  const prompt = `文本：${text}\n请抽取 claim。`;
  const raw = await _chat({ model: FLASH_MODEL, system, prompt, jsonMode: true });
  let arr;
  try { arr = JSON.parse(raw); } catch { arr = null; }
  if (!Array.isArray(arr)) {
    const m = raw.match(/\[[\s\S]*\]/);
    try { arr = m ? JSON.parse(m[0]) : []; } catch { arr = []; }
  }
  return arr
    .filter(c => c && typeof c.subject === 'string' && c.subject.trim())
    .map(c => ({
      subject: normalizeValue(c.subject),
      slot: typeof c.slot === 'string' ? c.slot : 'other',
      value: normalizeValue(c.value || ''),
      polarity: Number(c.polarity) === -1 ? -1 : 1,
      valid_from: typeof c.valid_from === 'string' && c.valid_from ? c.valid_from : null,
      valid_to: typeof c.valid_to === 'string' && c.valid_to ? c.valid_to : null,
      source,
      confidence: 0.85,
      text_span: typeof c.text_span === 'string' ? c.text_span : text,
    }));
}

/**
 * 统一入口：优先 LLM，失败/无 Key 降级规则抽取
 * 结果缓存到 claims 表
 */
export async function extractClaims(insightId, text, source = '', { useCache = true } = {}) {
  const db = getDb();

  // 缓存命中
  if (useCache) {
    const cached = db.prepare('SELECT subject,slot,value,polarity,valid_from,valid_to,source,confidence,text_span FROM claims WHERE insight_id=?').all(insightId);
    if (cached.length) return cached;
  }

  // 纯规则抽取（省 API 调用，每条入库只调 1 次 Flash 做观点提取）
  // 如需 LLM 抽取，设 CLAIM_EXTRACT=llm
  let claims;
  let via;
  if (process.env.CLAIM_EXTRACT === 'llm' && llmAvailable()) {
    try {
      claims = await llmExtractClaims(text, source);
      via = 'llm';
    } catch {
      claims = ruleExtractClaims(text, source);
      via = 'rule';
    }
  } else {
    claims = ruleExtractClaims(text, source);
    via = 'rule';
  }

  if (!claims.length) {
    // 兜底：至少一条 desc claim
    claims = ruleExtractClaims(text, source);
  }

  // 写入缓存
  const del = db.prepare('DELETE FROM claims WHERE insight_id=?');
  const ins = db.prepare('INSERT INTO claims (insight_id,subject,slot,value,polarity,valid_from,valid_to,source,confidence,text_span) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const tx = db.transaction(() => {
    del.run(insightId);
    for (const c of claims) {
      ins.run(insightId, c.subject, c.slot, String(c.value), c.polarity, c.valid_from, c.valid_to, c.source, c.confidence, c.text_span);
    }
  });
  tx();

  console.error(`[claims] ${insightId.slice(0, 8)}: ${claims.length} claims via ${via}`);
  return claims;
}

/**
 * 获取已缓存的 claims（不触发抽取）
 */
export function getCachedClaims(insightId) {
  const db = getDb();
  return db.prepare('SELECT subject,slot,value,polarity,valid_from,valid_to,source,confidence,text_span FROM claims WHERE insight_id=?').all(insightId);
}
