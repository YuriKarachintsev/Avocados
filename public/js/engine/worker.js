// Runs editing ops off the main thread.
import { applyOp } from './ops.js';

const assets = new Map();

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'putAsset') { assets.set(m.id, m.asset); return; }
  if (m.type === 'clearAssets') { assets.clear(); return; }
  if (m.type !== 'run') return;
  try {
    let img = { width: m.img.width, height: m.img.height, data: new Uint8ClampedArray(m.img.buffer) };
    const ctx = { faces: m.faces, fullWidth: m.fullWidth, assets: Object.fromEntries(assets) };
    for (const op of m.ops) img = applyOp(img, op, ctx);
    self.postMessage({ id: m.id, ok: true, img: { width: img.width, height: img.height, buffer: img.data.buffer } }, [img.data.buffer]);
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String(err?.message || err) });
  }
};
