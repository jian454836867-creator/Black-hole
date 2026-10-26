// DeepSeek 客户端：Flash（廉价提取）/ Pro（复杂合成）路由 + prompt 缓存
// 未配置 DEEPSEEK_API_KEY 时全部抛 LlmUnavailable，由调用方降级
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// .env 加载
function loadEnv() {
  const p = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !m[2].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, '');
const FLASH_MODEL = process.env.DEEPSEEK_FLASH_MODEL || 'deepseek-flash';   // V4.1 Flash：日常提取/claim抽取/问答
const PRO_MODEL = process.env.DEEPSEEK_PRO_MODEL || 'deepseek-v4-pro';       // V4-Pro：深度推理

export class LlmUnavailable extends Error {
  constructor(msg = 'DEEPSEEK_API_KEY 未配置') { super(msg); this.name = 'LlmUnavailable'; }
}

// ---- prompt 缓存（按内容 hash，文件存储）----
const CACHE_DIR = path.resolve(process.cwd(), 'data', 'llm-cache');
const cacheFile = (hash) => path.join(CACHE_DIR, `${hash}.json`);

function cacheGet(prompt, system) {
  try {
    const hash = crypto.createHash('sha256').update(system + '\n' + prompt).digest('hex').slice(0, 32);
    const f = cacheFile(hash);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {}
  return null;
}
function cachePut(prompt, system, result) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const hash = crypto.createHash('sha256').update(system + '\n' + prompt).digest('hex').slice(0, 32);
    fs.writeFileSync(cacheFile(hash), JSON.stringify(result));
  } catch {}
}

async function chat({ model, system, prompt, temperature = 0.2, jsonMode = false, useCache = true }) {
  if (!API_KEY) throw new LlmUnavailable();
  if (useCache) {
    const hit = cacheGet(prompt, system);
    if (hit) return hit;
  }
  const body = {
    model,
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`DeepSeek API ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  cachePut(prompt, system, content);
  return content;
}

// ---- 业务接口 ----

// 1) 观点提取（Flash）：从文本提取 1-3 条 insights，返回 JSON 数组
export async function extractInsights(text, { maxItems = 3 } = {}) {
  const system = `你是一个观点提取器。从给定文本中提取 1-${maxItems} 条独立的核心观点/事实/记忆。
要求：
- 每条用一句完整的话表达（10-50 字），保留具体的人名、事物、数字
- 事实陈述（如"我老板是XXX"）也算观点，必须提取
- 附一个一句话摘要 summary
- 附 2-4 个 tags（关键词，人名必须放 tags）
- 只有纯寒暄（你好/谢谢）才返回空数组
只输出 JSON，格式：{"insights":[{"content":"...","summary":"...","tags":["..."]}]}
不要输出任何 JSON 之外的内容。`;
  const prompt = `文本：\n"""\n${text.slice(0, 8000)}\n"""\n\n请提取观点。`;
  const raw = await chat({ model: FLASH_MODEL, system, prompt, jsonMode: true });
  const parsed = safeJson(raw);
  const list = Array.isArray(parsed?.insights) ? parsed.insights : [];
  return list
    .filter(x => x && typeof x.content === 'string' && x.content.trim())
    .slice(0, maxItems)
    .map(x => ({
      content: x.content.trim(),
      summary: typeof x.summary === 'string' ? x.summary.trim() : '',
      tags: Array.isArray(x.tags) ? x.tags.filter(t => typeof t === 'string').slice(0, 4) : [],
    }));
}

// 2) RAG 问答（Flash 常规 / Pro 深度）：基于召回上下文回答，带引用
export async function answer(question, contextItems, { deep = false, localOnly = false } = {}) {
  // 隐私路由：private 数据且无云端 → 调用方应在 localOnly=true 时走本地回答
  if (localOnly) return localAnswer(question, contextItems);
  const strong = contextItems.filter(c => !c._weak);
  const weak = contextItems.filter(c => c._weak);
  const ctx = strong
    .map((c, i) => `[${i + 1}]（相关度 ${(c._score ?? 0).toFixed(2)}）${c.content}${c.summary ? `（${c.summary}）` : ''}`)
    .join('\n');
  const weakNote = weak.length
    ? `\n\n以下编号为弱相关命中（相关度 < 0.55），内容已隐藏，严禁作为回答依据：${weak.map((c, i) => `[${strong.length + i + 1}]`).join(' ')}`
    : '';
  const system = `你是黑盒知识库的问答助手。基于下方"召回的观点"回答用户问题。
规则：
- 只基于召回观点回答，严禁编造、严禁引入外部知识
- 每条观点标注了与问题的相关度（0~1）：
  · 相关度 >= 0.70：可作为回答依据
  · 相关度 < 0.70：视为不相关，严禁引用、严禁提及
- 如果没有任何观点的相关度 >= 0.70 足以回答问题，必须且只回答这一句话："库中暂无相关观点。请持续投喂相关知识。"（不要解释、不要列引用、不要加任何其它字）
- 回答末尾用 [n] 标注引用的观点编号（只引用相关度 >= 0.70 的）
${deep ? '- 此题需要深度推理，请给出适用边界分析' : ''}`;
  const prompt = `召回的观点：\n${ctx || '（无）'}${weakNote}\n\n用户问题：${question}\n\n请回答。`;
  return chat({ model: deep ? PRO_MODEL : FLASH_MODEL, system, prompt, useCache: false });
}

// 3) 关系判定（v2 已移到 src/rel/classify.js，纯规则 + claim 对齐，不调 LLM）

// 本地降级回答（无云端时）
function localAnswer(question, contextItems) {
  const strong = contextItems.filter(c => !c._weak && (c._score ?? 0) >= 0.70);
  if (!strong.length) return '⚠️ 未触网（本地模式）：库中暂无相关观点。请持续投喂相关知识。';
  const best = strong.slice(0, 3)
    .map((c, i) => `[${i + 1}]（相关度 ${(c._score ?? 0).toFixed(2)}）${c.content}${c.summary ? ` —— ${c.summary}` : ''}`)
    .join('\n');
  return `⚠️ 未触网（本地模式，仅基于本地词条）：\n${best}`;
}

function safeJson(raw) {
  try { return JSON.parse(raw); } catch {}
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch {}
  return null;
}

export const llmAvailable = () => !!API_KEY;
export { chat as _chat }; // 暴露内部 chat 供 article-comparator 直接调用
