// Step 5 · 微信 iLink 桥（Black hole）
// 协议端点取自官方 @tencent-weixin/openclaw-weixin 包（v2.4.10 已装在本机 node_modules，仅参考其协议，产品已改名 Black hole）：
//   - 服务端 https://ilinkai.weixin.qq.com，JSON-over-HTTP 长轮询（非 WebSocket）
//   - 登录：POST /ilink/bot/get_bot_qrcode?bot_type=3 → { qrcode, qrcode_img_content }
//           GET  /ilink/bot/get_qrcode_status?qrcode=...（35s 长轮询）→ wait/scaned/confirmed/expired...
//   - 收消息：POST /ilink/bot/getupdates（35s 长轮询，body 带 get_updates_buf 游标）
//   - 发消息：POST /ilink/bot/sendmessage（msg 结构：item_list + message_type=2）
//   - 关键请求头：iLink-App-Id / iLink-App-ClientVersion / AuthorizationType / X-WECHAT-UIN（随机）
//   - 关键坑：消息 ID 是 uint64（超 JS 安全整数）→ 无损 JSON 解析；一个 bot 同时只能一个客户端 poll
//   - 状态机含 need_verifycode（手机显示数字需输入）、scaned_but_redirect（换 host 继续轮询）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db/db.js';
import { insertRawFile, insertInsight, attachVector, insertArticle, attachArticleVector } from '../db/repo.js';
import { embedder } from '../model/embedder.js';
import { onInsightCreated } from '../pipeline/ingest.js';
import { isValuable } from '../pipeline/filter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.BLACKHOLE_CONFIG || path.resolve(__dirname, '../../config.json');

const ILINK_HOST = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3';
const CHANNEL_VERSION = '2.4.10';
const APP_ID = 'bot';
const APP_CLIENT_VERSION = ((2 & 0xff) << 16) | ((4 & 0xff) << 8) | (10 & 0xff); // 2.4.10
const QR_POLL_TIMEOUT_MS = 35000;
const LONG_POLL_TIMEOUT_MS = 35000;

// ---------- 无损 JSON（uint64 消息 ID 保真，对齐官方 parseWeixinApiJson） ----------
let jsonBigint = null;
try { jsonBigint = (await import('json-bigint')).default; } catch {}
const parseJson = (text) => {
  if (jsonBigint) return jsonBigint({ storeAsString: true }).parse(text);
  return JSON.parse(text);
};
const baseInfo = () => ({ channel_version: CHANNEL_VERSION, bot_agent: 'OpenClaw' });
function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}
function buildHeaders(token) {
  const headers = {
    'Content-Type': 'application/json',
    'iLink-App-Id': APP_ID,
    'iLink-App-ClientVersion': String(APP_CLIENT_VERSION),
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (token) headers.Authorization = `Bearer ${String(token).trim()}`;
  return headers;
}

// ---------- 配置 ----------
function loadFullConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  const cfg = parseJson(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!cfg) return null;
  try {
    const envPath = path.resolve(__dirname, '../../.env');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && m[2] && !m[2].startsWith('#') && m[1] === 'DEEPSEEK_API_KEY' && m[2]) {
          cfg.llm = cfg.llm || {};
          if (!cfg.llm.apiKey) cfg.llm.apiKey = m[2];
          if (!cfg.llm.baseUrl) cfg.llm.baseUrl = 'https://api.deepseek.com/v1';
        }
      }
    }
  } catch {}
  return cfg;
}
function loadConfig() {
  const full = loadFullConfig();
  return full && full.weixin ? full.weixin : null;
}
function saveConfig(full) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(full, null, 2));
}
function pickAccount(cfg) {
  const accs = Object.values(cfg.accounts || {});
  if (!accs.length) return null;
  return accs.sort((a, b) => String(b.loggedInAt || '').localeCompare(String(a.loggedInAt || '')))[0];
}

// ---------- iLink HTTP ----------
async function ilink(endpoint, { method = 'POST', token, body, timeoutMs } = {}) {
  const url = new URL(endpoint, ILINK_HOST + '/');
  const ctrl = new AbortController();
  const t = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method,
      headers: buildHeaders(token),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? parseJson(text) : null; } catch { data = { _raw: text }; }
    return { ok: res.ok, status: res.status, data, text, aborted: false };
  } catch (e) {
    return { ok: false, status: 0, data: null, text: '', aborted: e.name === 'AbortError', error: e.message };
  } finally {
    if (t) clearTimeout(t);
  }
}

// ---------- 扫码登录 ----------
export async function startLogin() {
  const r = await ilink(`ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, {
    method: 'POST',
    body: { local_token_list: [], base_info: baseInfo() },
  });
  const qrcode = r.data?.qrcode;
  const qrcodeUrl = r.data?.qrcode_img_content;
  if (!qrcode || !qrcodeUrl) throw new Error(`iLink 未返回二维码（HTTP ${r.status}，${String(r.text || r.error || '').slice(0, 150)}）`);
  let baseUrl = ILINK_HOST;
  let pendingVerifyCode = undefined;
  let lastStatus = 'wait';

  async function poll() {
    let ep = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (pendingVerifyCode) ep += `&verify_code=${encodeURIComponent(pendingVerifyCode)}`;
    const r = await ilink(ep, { method: 'GET', timeoutMs: QR_POLL_TIMEOUT_MS + 5000 });
    // 长轮询客户端超时视为等待（官方同款行为）
    if (r.aborted || !r.data) return { status: 'wait' };
    const st = r.data?.status || 'wait';
    lastStatus = st;
    switch (st) {
      case 'confirmed': {
        const botId = r.data.ilink_bot_id;
        const botToken = r.data.bot_token;
        if (!botId) return { status: 'error', message: '登录成功但缺少 ilink_bot_id' };
        const full = loadFullConfig() || { llm: {}, weixin: { enabled: true, accounts: {} } };
        full.weixin = full.weixin || { enabled: true, accounts: {} };
        full.weixin.accounts[botId] = {
          botId,
          token: botToken,
          baseUrl: r.data.baseurl || baseUrl,
          userId: r.data.ilink_user_id || null,
          loggedInAt: new Date().toISOString(),
        };
        saveConfig(full);
        return { status: 'confirmed', botId, token: botToken, baseUrl: r.data.baseurl || baseUrl, userId: r.data.ilink_user_id };
      }
      case 'scaned_but_redirect': {
        if (r.data.redirect_host) baseUrl = `https://${r.data.redirect_host}`;
        return { status: 'wait' };
      }
      case 'need_verifycode':
        return { status: 'need_verifycode' };
      case 'verify_code_blocked':
        return { status: 'blocked' };
      case 'binded_redirect':
        return { status: 'already_bound' };
      case 'expired':
        return { status: 'expired' };
      default:
        return { status: st };
    }
  }
  function submitVerifyCode(code) { pendingVerifyCode = String(code); }
  return { qrcodeUrl, poll, submitVerifyCode, lastStatus: () => lastStatus };
}

// ---------- 纯文本入库（微信消息 private 入库 + 异步向量化 + 合成比对） ----------
function ingestTextDirect(text, { sourceFileId, sourceUrl = null }) {
  const created = [];
  const sentences = text.split(/(?<=[。！？!?\.])\s*/).map(s => s.trim());
  // 价值过滤：每条句子先过基础规则（无价值的不入库、不向量化、不触发合成比对）
  const items = sentences
    .filter(s => isValuable(s).valuable)
    .slice(0, 30); // 文章链接分支最多 30 条，普通文字 10 条
  if (!items.length) items.push(text.slice(0, 80)); // 整段无句子结构时兜底
  for (const s of items) {
    const { id } = insertInsight({ content: s, summary: '', tags: [], sourceFileId, sourceUrl });
    created.push({ id, content: s });
  }
  (async () => {
    for (const ins of created) {
      const [vec] = await embedder.embed([ins.content]);
      attachVector(ins.id, vec);
      onInsightCreated(ins.id);
    }
  })().catch(e => console.error('[weixin] 向量化失败:', e.message));
  return { insights: created };
}

// ---------- 链接抓取（微信发 URL → 抓正文 → private 入库 + 记录出处） ----------
const URL_RE = /^https?:\/\/[^\s]+$/i;

function extractHtmlText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchArticle(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const ctype = resp.headers.get('content-type') || '';
    if (!ctype.includes('text/html') && !ctype.includes('text/plain')) {
      throw new Error(`不支持的响应类型: ${ctype.slice(0, 50)}`);
    }
    const html = await resp.text();
    const text = extractHtmlText(html);
    if (text.length < 50) throw new Error('页面内容过少（可能是 JS 渲染或空页）');
    return text.slice(0, 20000); // 截断防超大页面
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 消息循环（getupdates 长轮询 → private 入库 → 回执） ----------
export async function startWeixinBridge({ onEvent = () => {} } = {}) {
  const cfg = loadConfig();
  if (!cfg || !cfg.enabled) throw new Error('config.json 缺少 weixin 配置（enabled:true + accounts）');
  const acc = pickAccount(cfg);
  if (!acc || !acc.token) throw new Error('无可用微信 bot 账号，请先扫码登录');
  const db = getDb();
  let stopping = false;
  let failCount = 0;
  let updatesBuf = ''; // get_updates_buf 游标（本地缓存，下次请求带回）

  async function handleMsg(m) {
    // 取文本：item_list 中 type=1 的 text_item.text（官方 bodyFromItemList 逻辑）
    const text = (m.item_list || [])
      .filter(it => it.type === 1 && it.text_item?.text)
      .map(it => String(it.text_item.text))
      .join('\n')
      .trim();
    if (!text) return;
    const fromUser = m.from_user_id || '';
    const msgId = m.message_id || '';

    // 发送辅助（官方 buildTextMessageReq 结构：message_type=2 BOT，item_list 文本项）
    const sendText = async (reply, ctxToken) => {
      const r = await ilink('ilink/bot/sendmessage', {
        method: 'POST',
        token: acc.token,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: fromUser,
            client_id: `ocm-${crypto.randomUUID()}`,
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text: reply } }],
            context_token: ctxToken || m.context_token || undefined,
          },
          base_info: baseInfo(),
        },
      });
      if (!r.ok && r.status !== 200) onEvent({ type: 'send_fail', status: r.status, err: String(r.text || '').slice(0, 150) });
    };

    try {
      // 命令识别（优先于入库）
      const t = text.replace(/\s+/g, '');
      if (t === '/clear') {
        // 清空黑盒（完全清空，不播种）
        const { resetAll } = await import('../db/repo.js');
        resetAll();
        await sendText('🧹 黑盒已清空（0 条）。');
        onEvent({ type: 'cmd', cmd: 'clear' });
        failCount = 0;
        return;
      }
      const qMatch = t.match(/^@?(?:问|ask)(.+)$/);
      if (qMatch) {
        // 提问：/ask 问xxx 或 问xxx → RAG 检索 → DeepSeek 回答（默认 normal 可触网）
        await sendText('🔍 检索中…', m.context_token);
        try {
          const { ask } = await import('../pipeline/rag.js');
          const r = await ask(qMatch[1], { k: 5, privacy: 'normal' });
          let reply = r.answer || '（无内容）';
          if (r.localOnly) reply = '⚠️ 未触网（本地模式）\n' + reply;
          const cites = (r.citations || []).slice(0, 3).map((c, i) => {
            const base = `[${i + 1}] ${String(c.content).slice(0, 40)}`;
            return c.sourceUrl ? base + `\n    出处: ${c.sourceUrl}` : base;
          }).join('\n');
          if (cites) reply += '\n引用：' + cites;
          reply = reply.slice(0, 1800);
          await sendText(reply, m.context_token);
          onEvent({ type: 'cmd', cmd: 'ask', q: qMatch[1].slice(0, 60), localOnly: r.localOnly });
        } catch (e2) {
          await sendText('❌ 提问失败：' + e2.message, m.context_token);
          onEvent({ type: 'cmd_err', cmd: 'ask', err: e2.message });
        }
        failCount = 0;
        return;
      }

      // 链接分支：微信发 URL → 抓正文 → 整篇存 articles 表（不拆短句）
      const urlMatch = text.trim().match(URL_RE);
      if (urlMatch) {
        const url = urlMatch[0];
        await sendText('📎 抓取中…', m.context_token);
        try {
          const articleText = await fetchArticle(url);
          // 提取标题（首行或 <title>）
          const title = articleText.split('\n')[0].slice(0, 100) || new URL(url).hostname;
          // 整篇存 articles 表
          const articleId = insertArticle({ url, title, content: articleText });
          // 文章级向量化（用全文前 500 字做 embedding，bge 上限 512 token）
          const [vec] = await embedder.embed([articleText.slice(0, 500)]);
          attachArticleVector(articleId, vec);
          // 文章碰撞：与已有文章比对，同主题则合成新文章
          const { compareNewArticle } = await import('../synth/article-comparator.js');
          const rels = await compareNewArticle(articleId, { judge: null });
          const domain = new URL(url).hostname;
          let reply = `👌 已收录 ${domain}：${title.slice(0, 40)}（${articleText.length} 字）`;
          if (rels.length) {
            reply += `\n🔗 与 ${rels.length} 篇已有文章同主题，已生成合并摘要`;
          }
          await sendText(reply, m.context_token);
          onEvent({ type: 'article_ingested', msgId, url, title: title.slice(0, 40), relations: rels.length });
        } catch (e) {
          await sendText('❌ 抓取失败：' + e.message, m.context_token);
          onEvent({ type: 'url_fail', msgId, url, err: e.message });
        }
        failCount = 0;
        return;
      }

      // 普通消息 → 价值过滤 → private 入库 + 回执
      // 无价值消息（你好/在吗/纯标点等，基础规则判定，不消耗模型）→ 不入库，静默忽略
      const verdict = isValuable(text);
      if (!verdict.valuable) {
        onEvent({ type: 'filtered', msgId, text: text.slice(0, 40), reason: verdict.reason });
        failCount = 0;
        return;
      }
      const rawFileId = insertRawFile({ privacyLevel: 'private', fileType: 'weixin', sourceUrl: 'weixin:iLink', rawText: text });
      onEvent({ type: 'recv', msgId, text: text.slice(0, 80) });
      const result = ingestTextDirect(text, { sourceFileId: rawFileId });
      if (!result.insights.length) {
        onEvent({ type: 'filtered', msgId, reason: '分句后全部无价值' });
        failCount = 0;
        return;
      }
      onEvent({ type: 'ingested', msgId, insights: result.insights.length });
      await sendText('👌 已入黑盒', m.context_token);
      failCount = 0;
    } catch (e) {
      onEvent({ type: 'error', msgId, err: e.message });
      console.error('[weixin] handle failed:', e.message);
    }
  }

  async function loop() {
    while (!stopping) {
      const r = await ilink('ilink/bot/getupdates', {
        method: 'POST',
        token: acc.token,
        body: { get_updates_buf: updatesBuf, base_info: baseInfo() },
        timeoutMs: LONG_POLL_TIMEOUT_MS + 5000,
      });
      // 长轮询客户端超时 = 正常（无新消息），继续
      if (r.aborted) continue;
      if (r.status === 401 || r.status === 403) {
        onEvent({ type: 'relogin', reason: 'token 失效（401/403），需要重新扫码' });
        return;
      }
      if (!r.ok) {
        failCount++;
        const delay = Math.min(60000, 1000 * 2 ** Math.min(failCount, 6));
        onEvent({ type: 'retry', err: `HTTP ${r.status}`, delayMs: delay, body: String(r.text || '').slice(0, 150) });
        await new Promise(s => setTimeout(s, delay));
        continue;
      }
      failCount = 0;
      const data = r.data || {};
      if (data.errcode && data.errcode !== 0) {
        // -14 = session timeout（官方行为），其他错误记录
        onEvent({ type: 'api_err', errcode: data.errcode, errmsg: data.errmsg || '' });
        if (data.errcode === -14) updatesBuf = ''; // session 重置，游标清空
        continue;
      }
      if (data.get_updates_buf != null) updatesBuf = data.get_updates_buf;
      for (const m of data.msgs || []) {
        if (m.message_type === 2) continue; // 跳过自己发的（BOT）
        await handleMsg(m);
      }
    }
  }

  onEvent({ type: 'started', botId: acc.botId });
  loop().catch(e => onEvent({ type: 'fatal', err: e.message }));
  return {
    stop: () => { stopping = true; },
    botId: acc.botId,
  };
}

// ---------- 20:00 定时聚合推送当天新增 relations ----------
export function startDailyNotify({ hour = 20, minute = 0, send } = {}) {
  const sendDefault = async (text) => {
    const cfg = loadConfig();
    const acc = pickAccount(cfg);
    if (!acc) return;
    await ilink('ilink/bot/sendmessage', {
      method: 'POST',
      token: acc.token,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: acc.userId || '',
          client_id: `ocm-daily-${crypto.randomUUID()}`,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
        },
        base_info: baseInfo(),
      },
    });
  };
  const doSend = send || sendDefault;
  let stopped = false;
  async function tick() {
    while (!stopped) {
      const now = new Date();
      const next = new Date(now);
      next.setHours(hour, minute, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      await new Promise(r => setTimeout(r, next - now));
      try {
        const db = getDb();
        const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
        const rels = db.prepare(
          `SELECT r.*, a.content AS content_a, b.content AS content_b
           FROM relations r JOIN insights a ON a.id=r.insight_a_id JOIN insights b ON b.id=r.insight_b_id
           WHERE r.created_at >= ? AND r.user_confirmed IN (0,1)`
        ).all(dayStart.toISOString().replace('T', ' ').slice(0, 19));
        if (!rels.length) continue;
        // 8 类关系 → 显示标签
        const REL_LABELS = {
          EQUIVALENT: '✨ 等价', CONTAINS: '📦 包含', VERSION: '🔄 版本更新',
          CONTRADICTS: '⚖️ 矛盾', PSEUDO_CONFLICT: '🔀 伪冲突',
          OVERLAPS: '🧩 互补', RELATED: '🔗 相关',
          merge: '✨ 融合', conflict: '⚖️ 冲突', // 兼容旧值
        };
        const lines = rels.map(r => {
          const tag = REL_LABELS[r.relation_type] || `📌 ${r.relation_type}`;
          return `【${tag}】\n· ${r.content_a}\n↔ ${r.content_b}\n（${(r.explanation || '').slice(0, 60)}）`;
        });
        await doSend(`📦 黑盒日报 ${new Date().toLocaleDateString('zh-CN')}\n\n` + lines.join('\n\n'));
      } catch (e) { console.error('[weixin] daily notify failed:', e.message); }
    }
  }
  tick();
  return { stop: () => { stopped = true; } };
}

// ---------- 直接运行：node src/bridges/weixin.js [login] ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] || 'run';
  if (mode === 'login') {
    startLogin().then(({ qrcodeUrl, poll, submitVerifyCode }) => {
      console.log('QR URL:', qrcodeUrl);
      console.log('（用浏览器打开上方 URL 显示二维码，或转成二维码图片用微信扫）');
      (async () => {
        let expectCode = false;
        while (true) {
          const r = await poll();
          if (r.status === 'confirmed') { console.log('LOGIN OK', r.botId); process.exit(0); }
          if (r.status === 'expired') { console.log('二维码过期，请重新运行'); process.exit(1); }
          if (r.status === 'need_verifycode') {
            expectCode = true;
            console.log('请输入手机微信显示的数字：');
            const line = await new Promise(res => {
              process.stdin.resume();
              process.stdin.once('data', d => res(d.toString().trim()));
            });
            expectCode = false;
            submitVerifyCode(line);
            continue;
          }
          if (expectCode) { expectCode = false; }
          console.log('status:', r.status);
          await new Promise(x => setTimeout(x, 1000));
        }
      })();
    }).catch(e => { console.error('LOGIN FAIL:', e.message); process.exit(1); });
  } else {
    startWeixinBridge({ onEvent: e => console.log('[weixin]', JSON.stringify(e)) });
    startDailyNotify();
  }
}
