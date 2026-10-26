// 静态伺服 gui/dist（替代 vite dev，避免 EBUSY 问题）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../../gui/dist');
const PORT = Number(process.env.PORT || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  // CORS for API
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // /api 代理到 :7700
  if (req.url.startsWith('/api/')) {
    const apiReq = http.request({ hostname: '127.0.0.1', port: 7700, path: req.url, method: req.method, headers: { 'Content-Type': 'application/json' } }, (apiRes) => {
      res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      apiRes.pipe(res);
    });
    apiReq.on('error', (e) => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
    req.pipe(apiReq);
    return;
  }

  let filePath = path.join(DIST, req.url === '/' ? 'index.html' : req.url);
  if (!filePath.startsWith(DIST)) { res.writeHead(403); return res.end('Forbidden'); }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html');
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[static] 伺服 gui/dist → http://127.0.0.1:${PORT}/`);
});
process.on('SIGINT', () => { server.close(); process.exit(0); });
