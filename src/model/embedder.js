// 主进程侧：worker 池 + 队列 + Promise API
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'embed-worker.js');

class Embedder {
  constructor() {
    this.worker = null;
    this.queue = [];
    this.waiters = new Map(); // reqId -> {resolve, reject}
    this.seq = 0;
  }

  _ensureWorker() {
    if (this.worker && !this.worker.exited) return;
    this.worker = new Worker(WORKER_PATH);
    this.worker.on('message', (msg) => {
      if (msg.type === 'result') {
        const w = this.waiters.get(msg.reqId);
        if (w) { this.waiters.delete(msg.reqId); w.resolve(msg.vectors); }
      } else if (msg.type === 'error') {
        const w = this.waiters.get(msg.reqId);
        if (w) { this.waiters.delete(msg.reqId); w.reject(new Error(msg.error)); }
      }
    });
    this.worker.on('error', (e) => {
      console.error('[embedder] worker error:', e.message);
    });
  }

  async embed(texts) {
    this._ensureWorker();
    const reqId = ++this.seq;
    const p = new Promise((resolve, reject) => {
      this.waiters.set(reqId, { resolve, reject });
    });
    this.worker.postMessage({ type: 'embed', texts, reqId });
    return p;
  }

  async warmup() {
    // 预热：加载模型 + 跑一条，避免首次查询超时
    return this.embed(['预热']);
  }

  stop() {
    if (this.worker) this.worker.terminate();
  }
}

export const embedder = new Embedder();
