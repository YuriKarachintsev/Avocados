// Runs op sequences in a Web Worker (falls back to the main thread).
import { applyOp } from './ops.js';

export class Engine {
  constructor() {
    this.assets = new Map();
    this.pending = new Map();
    this.seq = 0;
    this.worker = null;
    try {
      this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.worker.onerror = () => this.failWorker();
    } catch {
      this.worker = null;
    }
  }

  failWorker() {
    const pend = [...this.pending.values()];
    this.pending.clear();
    try { this.worker?.terminate(); } catch { /* ignore */ }
    this.worker = null;
    for (const p of pend) this.runLocal(p.img, p.ops, p.meta).then(p.resolve, p.reject);
  }

  onMessage(m) {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.ok) p.resolve({ width: m.img.width, height: m.img.height, data: new Uint8ClampedArray(m.img.buffer) });
    else p.reject(new Error(m.error));
  }

  putAsset(id, asset) {
    this.assets.set(id, asset);
    this.worker?.postMessage({ type: 'putAsset', id, asset });
  }

  getAsset(id) { return this.assets.get(id); }

  clear() {
    this.assets.clear();
    this.worker?.postMessage({ type: 'clearAssets' });
  }

  run(img, ops, meta) {
    const runnable = ops.filter((o) => o && o.type !== 'frame');
    if (!runnable.length) return Promise.resolve(img);
    if (!this.worker) return this.runLocal(img, runnable, meta);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, img, ops: runnable, meta });
      const copy = img.data.slice();
      this.worker.postMessage({
        type: 'run', id, ops: runnable, faces: meta.faces, fullWidth: meta.fullWidth,
        img: { width: img.width, height: img.height, buffer: copy.buffer },
      }, [copy.buffer]);
    });
  }

  async runLocal(img, ops, meta) {
    await new Promise((r) => setTimeout(r, 0));
    const ctx = { faces: meta.faces, fullWidth: meta.fullWidth, assets: Object.fromEntries(this.assets) };
    let out = img;
    for (const op of ops) out = applyOp(out, op, ctx);
    return out;
  }
}
