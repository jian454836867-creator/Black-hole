// 本地 HTTP API（供 Tauri/Vue 前端调用）
// 端点：POST /ingest | POST /ask | GET /timeline | GET /relations/:id | POST /relations/:id/confirm | GET /health
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import crypto from 'node:crypto';
import { getDb } from '../db/db.js';
import { getInsight, confirmRelation } from '../db/repo.js';
import { ingest, timeline } from '../pipeline/ingest.js';
import { ask } from '../pipeline/rag.js';
import { embedder } from '../model/embedder.js';
import { llmAvailable } from '../pipeline/llm.js';

const _wxLogins = new Map(); // 微信扫码登录会话 { id: { login, status, createdAt } }

const PORT = Number(process.env.PORT || 7700);
const UPLOAD_DIR = path.resolve(process.cwd(), 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 配置兜底：config.json 存在时，把 llm.apiKey/baseUrl 同步到环境变量（必须在 llm.js 首次求值前执行）
function envKeyValue(p, key) {
  if (!fs.existsSync(p)) return '';
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && m[1] === key && m[2] && !m[2].startsWith('#')) return m[2];
  }
  return '';
}
function readConfigStatus() {
  // llm：.env 的 DEEPSEEK_API_KEY 非空 或 config.json 的 llm.apiKey 非空
  let llmConfigured = !!envKeyValue(path.resolve(process.cwd(), '.env'), 'DEEPSEEK_API_KEY');
  let weixinConfigured = false;
  try {
    const cfgPath = path.resolve(process.cwd(), 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (!llmConfigured && cfg.llm?.apiKey && cfg.llm.apiKey !== 'sk-xxx-填你的DeepSeekKey') llmConfigured = true;
      weixinConfigured = !!(cfg.weixin?.enabled && Object.keys(cfg.weixin?.accounts || {}).length);
    }
  } catch {}
  return { llmConfigured, weixinConfigured };
}

// 配置兜底：config.json 存在时，把 llm.apiKey/baseUrl 同步到环境变量（必须在 llm.js 首次求值前执行）
function syncConfigEnv() {
  try {
    const cfgPath = path.resolve(process.cwd(), 'config.json');
    if (!fs.existsSync(cfgPath)) return;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.llm?.apiKey && !process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = cfg.llm.apiKey;
    if (cfg.llm?.baseUrl && !process.env.DEEPSEEK_BASE_URL) process.env.DEEPSEEK_BASE_URL = cfg.llm.baseUrl;
  } catch (e) {
    console.error('[api] 读取 config.json 失败:', e.message);
  }
}
syncConfigEnv();

getDb(); // 确保建表
console.error('[api] 预热模型...');
const modelReady = embedder.warmup().then(() => console.error('[api] 模型就绪'), e => console.error('[api] 模型预热失败:', e.message));

// Step 5 微信 iLink 桥（可选：config.json 存在且 weixin.enabled 时自动启动）
let _wxHandle = null;
function startWeixinIfNeeded() {
  if (_wxHandle) return; // 已启动
  try {
    const cfgPath = path.resolve(process.cwd(), 'config.json');
    if (!fs.existsSync(cfgPath)) return;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!cfg.weixin?.enabled) return;
    import('../bridges/weixin.js').then(m => {
      try {
        _wxHandle = m.startWeixinBridge({ onEvent: e => console.error('[weixin]', JSON.stringify(e)) });
        m.startDailyNotify();
      } catch (e2) { console.error('[api] 微信桥启动失败:', e2.message); }
    }).catch(e => console.error('[api] 微信桥未启动:', e.message));
  } catch (e) {
    console.error('[api] 微信桥未启动:', e.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  };

  // CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(200, { ok: true, llm: llmAvailable(), ts: Date.now() });
    }

    // 配置状态（GUI 首次引导用）—— 实时读 .env / config.json，不依赖进程启动时的缓存
    if (req.method === 'GET' && url.pathname === '/config/check') {
      const st = readConfigStatus();
      return send(200, { llmConfigured: st.llmConfigured, weixinConfigured: st.weixinConfigured });
    }

    // 保存 DeepSeek Key（写入 .env，下次启动生效）
    if (req.method === 'POST' && url.pathname === '/config/save') {
      const body = await readBody(req);
      const { apiKey } = JSON.parse(body || '{}');
      if (!apiKey || !apiKey.startsWith('sk-')) return send(400, { error: 'apiKey 必填（sk- 开头）' });
      const envPath = path.resolve(process.cwd(), '.env');
      let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      if (env.includes('DEEPSEEK_API_KEY=')) {
        env = env.replace(/^DEEPSEEK_API_KEY=.*/m, `DEEPSEEK_API_KEY=${apiKey}`);
      } else {
        env += `\nDEEPSEEK_API_KEY=${apiKey}\n`;
      }
      fs.writeFileSync(envPath, env);
      return send(200, { ok: true, note: '已写入 .env。重启后端后生效（重跑 启动.ps1 或 npm start）。' });
    }

    // 微信扫码登录：启动 iLink 登录会话，返回二维码 URL + 会话 ID
    if (req.method === 'POST' && url.pathname === '/weixin/login') {
      let weixinMod;
      try { weixinMod = await import('../bridges/weixin.js'); }
      catch (e) { return send(500, { error: '微信桥模块加载失败: ' + e.message }); }
      try {
        const login = await weixinMod.startLogin();
        const id = crypto.randomUUID();
        _wxLogins.set(id, { login, status: 'waiting', createdAt: Date.now() });
        // 定期清理 10 分钟前的会话
        for (const [k, v] of _wxLogins) if (Date.now() - v.createdAt > 600000) _wxLogins.delete(k);
        return send(200, { id, qrcodeUrl: login.qrcodeUrl });
      } catch (e) {
        return send(500, { error: '获取二维码失败: ' + e.message });
      }
    }

    // 微信扫码状态轮询（轮询间隔由前端控制，约 1s）
    if (req.method === 'GET' && url.pathname.startsWith('/weixin/login/')) {
      const id = url.pathname.split('/').pop();
      const s = _wxLogins.get(id);
      if (!s) return send(404, { error: '会话不存在或已过期，请重新生成' });
      try {
        const r = await s.login.poll();
        if (r.status === 'confirmed') {
          s.status = 'confirmed';
          _wxLogins.delete(id);
          // 登录后自动拉起桥（若 weixin.enabled）
          setTimeout(() => startWeixinIfNeeded(), 1000);
          return send(200, { status: 'confirmed', botId: r.botId });
        }
        if (r.status === 'already_bound') {
          s.status = 'already_bound';
          _wxLogins.delete(id);
          return send(200, { status: 'already_bound' });
        }
        if (r.status === 'expired') { s.status = 'expired'; _wxLogins.delete(id); return send(200, { status: 'expired' }); }
        s.status = r.status;
        return send(200, { status: r.status || 'waiting' });
      } catch (e) {
        return send(200, { status: s.status, error: e.message });
      }
    }

    // 提交扫码配对码（need_verifycode 状态时）
    if (req.method === 'POST' && url.pathname.startsWith('/weixin/login/')) {
      const id = url.pathname.split('/').pop();
      const s = _wxLogins.get(id);
      if (!s) return send(404, { error: '会话不存在或已过期，请重新生成' });
      const body = await readBody(req);
      const { code } = JSON.parse(body || '{}');
      if (!code) return send(400, { error: 'code 必填' });
      s.login.submitVerifyCode(code);
      return send(200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/timeline') {
      const items = timeline({ limit: Number(url.searchParams.get('limit')) || 100 });
      return send(200, { items });
    }

    if (req.method === 'GET' && url.pathname === '/articles') {
      const { listArticles } = await import('../db/repo.js');
      const items = listArticles({ limit: Number(url.searchParams.get('limit')) || 50 });
      return send(200, { items });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/insights/')) {
      const id = url.pathname.split('/').pop();
      const row = getInsight(id);
      if (!row) return send(404, { error: 'not found' });
      return send(200, { item: row });
    }

    if (req.method === 'POST' && url.pathname === '/clear') {
      const { resetAll } = await import('../db/repo.js');
      resetAll();
      return send(200, { ok: true, msg: '黑盒已清空（0 条）' });
    }

    if (req.method === 'POST' && url.pathname === '/relations/confirm') {
      const body = await readBody(req);
      const { id, state } = JSON.parse(body || '{}');
      if (!id || ![0, 1, -1].includes(Number(state))) return send(400, { error: 'id 与 state(0/1/-1) 必填' });
      confirmRelation(id, Number(state));
      return send(200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/ask') {
      const body = await readBody(req);
      const { question, deep = false, privacy = 'normal', k = 5 } = JSON.parse(body || '{}');
      if (!question) return send(400, { error: 'question 必填' });
      await modelReady;
      const t0 = Date.now();
      const result = await ask(question, { k, deep, privacy });
      result.latencyMs = Date.now() - t0;
      // 无知识路径不返回凑数引用（rag.js 已在 noKnowledge 时清空，双保险）
      if (result.noKnowledge) result.citations = [];
      return send(200, result);
    }

    if (req.method === 'POST' && url.pathname === '/ingest') {
      // 支持两种：1) multipart 上传文件 2) JSON {text, privacyLevel, sourceUrl}
      const ctype = req.headers['content-type'] || '';
      if (ctype.includes('application/json')) {
        const body = await readBody(req);
        const { text, privacyLevel = 'normal', sourceUrl = null, filename = null, fileType = null } = JSON.parse(body || '{}');
        if (!text) return send(400, { error: 'text 必填' });
        const tmp = path.join(UPLOAD_DIR, `txt_${Date.now()}.txt`);
        fs.writeFileSync(tmp, text, 'utf8');
        // 按文件名扩展名判断文件类型（.html 走粗提取）
        const ext = filename ? path.extname(filename).toLowerCase() : '';
        const ftype = fileType || (['.html', '.htm'].includes(ext) ? 'web' : 'text');
        await modelReady;
        const t0 = Date.now();
        const result = await ingest({ filePath: tmp, sourceUrl: sourceUrl || filename, privacyLevel, fileType: ftype });
        result.elapsedMs = Date.now() - t0;
        result.filename = filename || null;
        return send(200, result);
      }
      // multipart（兼容保留）
      const file = await readMultipart(req);
      if (!file) return send(400, { error: '未收到文件' });
      const privacyLevel = file.fields.privacyLevel || 'normal';
      const tmp = path.join(UPLOAD_DIR, `${Date.now()}_${file.filename}`);
      fs.writeFileSync(tmp, file.buffer);
      await modelReady;
      const t0 = Date.now();
      const result = await ingest({ filePath: tmp, privacyLevel, fileType: file.fileType });
      result.elapsedMs = Date.now() - t0;
      result.filename = file.filename;
      return send(200, result);
    }

    return send(404, { error: 'not found' });
  } catch (e) {
    console.error('[api] error:', e);
    return send(500, { error: e.message });
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e7) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const boundary = (req.headers['content-type'] || '').match(/boundary=(.+)/)?.[1];
    if (!boundary) return reject(new Error('missing boundary'));
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const parts = buf.split(Buffer.from(`--${boundary}`));
        for (const p of parts) {
          const m = p.match(/\r\n\r\n([\s\S]*)$/);
          if (!m) continue;
          const content = m[1].replace(/\r\n$/, '');
          const head = p.slice(0, p.indexOf(m[0])).toString('utf8');
          const name = head.match(/name="([^"]+)"/)?.[1];
          const fname = head.match(/filename="([^"]*)"/)?.[1];
          const ftype = head.match(/Content-Type:\s*([^;\r\n]+)/i)?.[1];
          if (fname) return resolve({ filename: fname, fileType: ftype, buffer: content, fields: { privacyLevel: parseField(parts, 'privacyLevel') } });
          if (name) { /* plain field */ }
        }
        reject(new Error('no file part'));
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function parseField(parts, name) {
  for (const p of parts) {
    const head = p.slice(0, p.indexOf('\r\n\r\n')).toString('utf8');
    const m = head.match(new RegExp(`name="${name}"`));
    if (m) {
      const body = p.match(/\r\n\r\n([\s\S]*?)\r\n--/)?.[1];
      if (body) return body;
    }
  }
  return undefined;
}

server.listen(PORT, () => {
  console.error(`[api] 监听 http://127.0.0.1:${PORT}`);
  startWeixinIfNeeded();
});

process.on('SIGINT', () => { embedder.stop(); process.exit(0); });
