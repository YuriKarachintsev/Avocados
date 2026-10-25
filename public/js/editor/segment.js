// On-device person cut-out (MediaPipe Selfie Segmentation model, Apache-2.0,
// TF.js conversion by V. Mandic, MIT) refined with a guided filter.
import { loadFaceModels, getTf } from './faces.js';
import { cropToCanvas } from './imageio.js';
import { guidedFilter, resizeMask, smoothstep } from '../engine/raster.js';

let model = null;

async function getModel() {
  await loadFaceModels();
  const tf = getTf();
  if (!model) model = await tf.loadGraphModel('/models/selfie.json');
  return { tf, model };
}

export async function segmentOnDevice(img, { workLong = 1024 } = {}) {
  const { tf, model: m } = await getModel();
  const W = img.width; const H = img.height;
  // Letterbox into a square so the person isn't distorted.
  const side = Math.max(W, H);
  const S = 256;
  const k = S / side;
  const dw = Math.round(W * k); const dh = Math.round(H * k);
  const ox = Math.floor((S - dw) / 2); const oy = Math.floor((S - dh) / 2);
  const small = cropToCanvas(img, { x: 0, y: 0, w: W, h: H }, dw, dh);
  const sq = document.createElement('canvas');
  sq.width = S; sq.height = S;
  const g = sq.getContext('2d');
  g.fillStyle = '#808080';
  g.fillRect(0, 0, S, S);
  g.drawImage(small, ox, oy);
  small.width = 1; small.height = 1;

  const out = tf.tidy(() => {
    const x = tf.browser.fromPixels(sq).toFloat().div(255).expandDims(0);
    let y = m.predict(x);
    if (Array.isArray(y)) y = y[0];
    return y.squeeze();
  });
  const raw = await out.data();
  out.dispose();

  // crop the letterbox back out
  const crop = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) crop[y * dw + x] = raw[(y + oy) * S + (x + ox)];

  // refine at working resolution using the photo as the guide
  const s = Math.min(1, workLong / Math.max(W, H));
  const ww = Math.max(16, Math.round(W * s)); const wh = Math.max(16, Math.round(H * s));
  const coarse = resizeMask({ width: dw, height: dh, data: crop }, ww, wh);
  const guideCanvas = cropToCanvas(img, { x: 0, y: 0, w: W, h: H }, ww, wh);
  const gd = guideCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, ww, wh).data;
  guideCanvas.width = 1; guideCanvas.height = 1;
  const I = new Float32Array(ww * wh);
  for (let p = 0; p < I.length; p++) I[p] = (0.299 * gd[p * 4] + 0.587 * gd[p * 4 + 1] + 0.114 * gd[p * 4 + 2]) / 255;
  for (let p = 0; p < coarse.length; p++) coarse[p] = smoothstep(0.25, 0.75, coarse[p]);
  const refined = guidedFilter(I, coarse, ww, wh, Math.max(2, Math.round(ww * 0.008)), 0.0008);
  const mask = new Uint8Array(ww * wh);
  for (let p = 0; p < mask.length; p++) mask[p] = Math.round(smoothstep(0.08, 0.92, refined[p]) * 255);
  return { width: ww, height: wh, data: mask };
}
