// worker_threads：加载 bge-small-zh-v1.5 (INT8 ONNX)，导出 embed()
// 主线程不持有模型，避免卡 UI
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
// .env 加载（worker 独立进程，需自行读取）
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && m[2] && !m[2].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch {}
import { AutoTokenizer, pipeline, env } from '@huggingface/transformers';
// 国内镜像源（huggingface.co 直连超时）
const HF_ENDPOINT = process.env.HF_ENDPOINT || 'https://huggingface.co/';
env.remoteHost = HF_ENDPOINT.endsWith('/') ? HF_ENDPOINT : HF_ENDPOINT + '/';
if (process.env.TRANSFORMERS_CACHE) env.cacheDir = process.env.TRANSFORMERS_CACHE;
console.error('[embed-worker] remoteHost =', env.remoteHost, '| cacheDir =', env.cacheDir);

let extractor = null;
let tokenizer = null;
const MODEL = 'Xenova/bge-small-zh-v1.5';

async function init() {
  if (extractor) return;
  console.error('[embed-worker] loading tokenizer', MODEL);
  tokenizer = await AutoTokenizer.from_pretrained(MODEL);
  console.error('[embed-worker] loading pipeline (first run downloads ~24MB ONNX)');
  extractor = await pipeline('feature-extraction', MODEL, { quantized: true });
  console.error('[embed-worker] ready');
}

// 对 [seq, token, dim] 的 tensor 做 mean-pooling + L2 归一化
function meanPoolL2(values3d) {
  const seq = values3d.length;
  const out = [];
  for (let s = 0; s < seq; s++) {
    const tokens = values3d[s];
    const dim = tokens[0].length;
    const acc = new Float32Array(dim);
    for (const t of tokens) for (let i = 0; i < dim; i++) acc[i] += t[i];
    const n = tokens.length || 1;
    for (let i = 0; i < dim; i++) acc[i] /= n;
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += acc[i] * acc[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) acc[i] /= norm;
    out.push(acc);
  }
  return out;
}

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'ping') {
      parentPort.postMessage({ type: 'pong' });
      return;
    }
    if (msg.type === 'embed') {
      await init();
      const { texts, reqId } = msg;
      // bge 系 embedding 模型：检索场景加指令前缀（官方推荐）
      const prefixed = texts.map(t => '为这个句子生成表示以用于检索相关文章：' + t);
      // pipeline 内部自动 tokenize（padding+truncation 至 512）
      const out = await extractor(prefixed, { pooling: 'mean', normalize: true });
      // 输出 Tensor: dims [seq, dim]，dim=512（bge-small-zh）
      const dim = out.dims[out.dims.length - 1];
      const results = [];
      for (let i = 0; i < out.dims[0]; i++) {
        const start = i * dim;
        results.push(Array.from(out.data.subarray(start, start + dim)));
      }
      console.error(`[embed-worker] embedded ${results.length} text(s), dim=${dim}`);
      parentPort.postMessage({ type: 'result', reqId, vectors: results });
      return;
    }
    parentPort.postMessage({ type: 'error', reqId: msg.reqId, error: 'unknown message type' });
  } catch (e) {
    parentPort.postMessage({ type: 'error', reqId: msg.reqId, error: e.message + '\n' + (e.stack || '') });
  }
});
