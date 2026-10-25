// Shared helpers for face-only edits: crop the face region into float channels,
// build a skin mask (face outline minus eyes, brows, lips, nostrils, gated by skin colour),
// and write results back. Everything outside the region is never touched.
import { smoothstep, gaussBlur, fillPolygon, scalePoly } from './raster.js';
import {
  faceMetrics, facePolygon, eyePolys, mouthOuter, browPolys, nostrilPoly, scaleLandmarks, boxOf,
} from './face.js';

export function prepareFaceRegion(img, face, ctx, { pad = 0.12, forehead = 0.45 } = {}) {
  const s = img.width / ctx.fullWidth;
  const lmFull = scaleLandmarks(face.landmarks, s);
  const m = faceMetrics(lmFull);
  if (m.faceW < 24) return null;
  const bb = boxOf(facePolygon(lmFull, forehead));
  const pd = m.faceW * pad;
  const rx = Math.max(0, Math.floor(bb.x - pd)); const ry = Math.max(0, Math.floor(bb.y - pd));
  const rx1 = Math.min(img.width, Math.ceil(bb.x + bb.w + pd)); const ry1 = Math.min(img.height, Math.ceil(bb.y + bb.h + pd));
  const w = rx1 - rx; const h = ry1 - ry;
  if (w < 8 || h < 8) return null;
  const lm = lmFull.map(([x, y]) => [x - rx, y - ry]);
  const n = w * h;
  const R = new Float32Array(n); const G = new Float32Array(n); const B = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y + ry) * img.width + (x + rx)) * 4; const p = y * w + x;
      R[p] = img.data[i] / 255; G[p] = img.data[i + 1] / 255; B[p] = img.data[i + 2] / 255;
    }
  }
  return { rx, ry, w, h, n, lm, faceW: m.faceW, R, G, B, _skin: null };
}

export function skinMask(reg) {
  if (reg._skin) return reg._skin;
  const { w, h, n, lm, faceW, R, G, B } = reg;
  const skin = new Float32Array(n);
  fillPolygon(skin, w, h, facePolygon(lm, 0.3), 1);
  for (const e of eyePolys(lm)) fillPolygon(skin, w, h, scalePoly(e, 1.9), 0);
  for (const b of browPolys(lm, faceW * 0.035)) fillPolygon(skin, w, h, scalePoly(b, 1.15), 0);
  fillPolygon(skin, w, h, scalePoly(mouthOuter(lm), 1.12), 0);
  fillPolygon(skin, w, h, scalePoly(nostrilPoly(lm), 1.2), 0);
  // reference skin colour from the cheeks
  const refPts = [lm[2], lm[3], lm[13], lm[14], lm[29], lm[30]];
  let mCb = 0; let mCr = 0; let cnt = 0;
  for (let k = 0; k < refPts.length; k++) {
    const t = k < 4 ? 0.35 : 0;
    const px = Math.round(refPts[k][0] + (lm[30][0] - refPts[k][0]) * t);
    const py = Math.round(refPts[k][1] + (lm[30][1] - refPts[k][1]) * t);
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const p = py * w + px;
    mCb += -0.1146 * R[p] - 0.3854 * G[p] + 0.5 * B[p];
    mCr += 0.5 * R[p] - 0.4542 * G[p] - 0.0458 * B[p];
    cnt++;
  }
  if (cnt) { mCb /= cnt; mCr /= cnt; }
  for (let p = 0; p < n; p++) {
    if (!skin[p] || !cnt) continue;
    const cb = -0.1146 * R[p] - 0.3854 * G[p] + 0.5 * B[p];
    const cr = 0.5 * R[p] - 0.4542 * G[p] - 0.0458 * B[p];
    skin[p] *= smoothstep(0.06, 0.025, Math.sqrt((cb - mCb) ** 2 + (cr - mCr) ** 2));
  }
  reg._skin = gaussBlur(skin, w, h, Math.max(1, faceW * 0.02));
  return reg._skin;
}

export function writeBack(out, img, reg) {
  const { rx, ry, w, h, R, G, B } = reg;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y + ry) * img.width + (x + rx)) * 4; const p = y * w + x;
      out.data[i] = R[p] * 255; out.data[i + 1] = G[p] * 255; out.data[i + 2] = B[p] * 255;
    }
  }
}

// YCbCr helpers (BT.709, values 0–1, chroma centred on 0)
export const toY = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const toCb = (r, g, b) => -0.1146 * r - 0.3854 * g + 0.5 * b;
export const toCr = (r, g, b) => 0.5 * r - 0.4542 * g - 0.0458 * b;
export function fromYCC(y, cb, cr) {
  return [y + 1.5748 * cr, y - 0.1873 * cb - 0.4681 * cr, y + 1.8556 * cb];
}
export function hexToYCC(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  const r = ((v >> 16) & 255) / 255; const g = ((v >> 8) & 255) / 255; const b = (v & 255) / 255;
  return [toY(r, g, b), toCb(r, g, b), toCr(r, g, b)];
}

// Fill a thick polyline (variable width) into a plane.
export function strokePolyline(plane, w, h, pts, widths, value = 1) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i]; const [x1, y1] = pts[i + 1];
    const w0 = widths[i] / 2; const w1 = widths[i + 1] / 2;
    const dx = x1 - x0; const dy = y1 - y0; const L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L; const ny = dx / L;
    fillPolygon(plane, w, h, [[x0 + nx * w0, y0 + ny * w0], [x1 + nx * w1, y1 + ny * w1], [x1 - nx * w1, y1 - ny * w1], [x0 - nx * w0, y0 - ny * w0]], value);
  }
  return plane;
}

export function gaussianBlob(plane, w, h, cx, cy, rx, ry, amp = 1) {
  const x0 = Math.max(0, Math.floor(cx - rx * 3)); const x1 = Math.min(w, Math.ceil(cx + rx * 3));
  const y0 = Math.max(0, Math.floor(cy - ry * 3)); const y1 = Math.min(h, Math.ceil(cy + ry * 3));
  for (let y = y0; y < y1; y++) {
    const dy = (y + 0.5 - cy) / ry;
    for (let x = x0; x < x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const v = amp * Math.exp(-0.5 * (dx * dx + dy * dy));
      const p = y * w + x;
      if (v > plane[p]) plane[p] = v;
    }
  }
  return plane;
}
