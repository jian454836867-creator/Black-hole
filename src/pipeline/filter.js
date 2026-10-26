// 消息价值过滤（基础规则，不需要大模型）
// 用途：微信消息入库前过滤无价值内容，避免污染召回池
//
// 为什么要这么严：bge-small-zh 对短句存在"向量退化"——
//   cos(你好, 李白) ≈ 0.71，cos(苏轼黄州, 李白) ≈ 0.53（实测）
// 短句的 embedding 会挤向"通用语义中心"，与任何查询都算"相关"，
// 直接摧毁相似度阈值过滤。因此 <12 字的消息一律不入库（除非含明确主题词）。

const GREETINGS = new Set([
  '你好', '您好', '嗨', '哈喽', 'hello', 'hi', 'hey', 'yo', '在吗', '在不在',
  '在么', '在么么', '哈', '嗯', '嗯嗯', '哦', '哦哦', '好', '好的', '好滴',
  'ok', 'okay', '哈哈', '呵呵', '啊', '收到', '明白', '了解', '知道了',
  '懂了', '行', '行的', '可以', '在的', '没在',
]);

const NOISE_RE = /^[\s\p{P}\p{S}\p{C}]+$/u; // 纯标点/符号/控制字符

// 主题词表（含这些词的短消息视为有价值，允许入库）
// 注意：纯人名（李白/苏轼）不算主题词——"苏轼"两个字入库后
// 只会污染召回（cos(苏轼, 李白) 也会很高），需要带上下文才入库
const TOPIC_WORDS = [
  '量子纠缠', '量子力学', '微服务', 'Kubernetes', 'k8s', '分布式', '架构',
  '沉没成本', '复利', '投资', '止损', '概率', '期望值',
  '条件反射', '巴甫洛夫', '认知偏差', '过度自信', '冰山理论',
  '兼爱', '非攻', '无为', '留白', '美学',
  '哲学', '心理学', '经济学', '物理学', '文学',
];

// 事实陈述模式（含这些关键词的短消息 = 在记事实，必须入库）
const FACT_RE = /(老板|公司|名字|姓名|电话|地址|生日|年龄|喜欢|讨厌|记得|记住|不要忘|永远|我的|我家|我老婆|我老公|我朋友|我同事|我同学|我老师|我客户)/;

/**
 * @param {string} text
 * @returns {{ valuable: boolean, reason?: string }}
 */
export function isValuable(text) {
  const t = (text || '').trim();
  if (!t) return { valuable: false, reason: 'empty' };
  if (NOISE_RE.test(t)) return { valuable: false, reason: '纯标点/符号' };

  const bare = t.toLowerCase().replace(/[\p{P}\s]/gu, '');

  // 1) 寒暄（整句就是打招呼）
  if (GREETINGS.has(bare) || GREETINGS.has(t.toLowerCase())) {
    return { valuable: false, reason: '寒暄' };
  }
  // 寒暄重复（你好你好你好）
  const greetLen = [...GREETINGS].reduce((n, g) => n + g.length * (bare.split(g.toLowerCase()).length - 1), 0);
  if (greetLen > 0 && greetLen / bare.length > 0.8) {
    return { valuable: false, reason: '寒暄重复' };
  }

  // 2) 长度门槛：CJK < 12 字 且 英文单词 < 5 个 → 短句退化区，默认不入库
  const cjkCount = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const wordCount = t.replace(/[\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(Boolean).length;
  if (cjkCount < 12 && wordCount < 5) {
    // 例外1：含明确主题词（短消息但信息密度高）
    const hasTopic = TOPIC_WORDS.some(w => t.toLowerCase().includes(w.toLowerCase()));
    if (hasTopic) return { valuable: true };
    // 例外2：事实陈述（"我老板是XXX"/"记住XXX"）→ 必须入库
    if (FACT_RE.test(t)) return { valuable: true };
    return { valuable: false, reason: '过短（<12字，短句向量退化）' };
  }

  return { valuable: true };
}

// 批量过滤（保留原顺序）
export function filterTexts(texts) {
  const valuable = [], filtered = [];
  for (const t of texts) {
    (isValuable(t).valuable ? valuable : filtered).push(t);
  }
  return { valuable, filtered };
}
