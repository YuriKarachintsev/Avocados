// Prepares a region of the photo for an AI edit and blends the result back
// only where that edit is meant to apply (clothes, hair or lower face),
// keeping the person's original face pixels.
import { cropToCanvas, canvasToBlob, canvasToImg, blobToImg } from './imageio.js';
import { detectFaces } from './faces.js';
import {
  createImg, resizeRGBA, sampleRGBA, gaussBlur, fillPolygon, fillEllipse, scalePoly, smoothstep,
} from '../engine/raster.js';
import { faceMetrics, facePolygon, STABLE_POINTS } from '../engine/face.js';

// Region of interest (full-resolution coords) for each feature.
export function roiFor(feature, face, W, H) {
  const { faceW, eyeMid, chin } = faceMetrics(face.landmarks);
  let x0; let x1; let y0; let y1;
  if (feature === 'outfit') {
    x0 = eyeMid[0] - faceW * 2.3; x1 = eyeMid[0] + faceW * 2.3;
    y0 = eyeMid[1] - faceW * 1.1; y1 = Math.min(H, chin[1] + faceW * 3.2);
  } else if (feature === 'hair') {
    x0 = eyeMid[0] - faceW * 1.5; x1 = eyeMid[0] + faceW * 1.5;
    y0 = eyeMid[1] - faceW * 1.35; y1 = chin[1] + faceW * 1.6;
  } else { // smile
    x0 = eyeMid[0] - faceW * 1.0; x1 = eyeMid[0] + faceW * 1.0;
    y0 = eyeMid[1] - faceW * 0.8; y1 = chin[1] + faceW * 0.5;
  }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function workSize(roi) {
  const long = Math.max(roi.w, roi.h);
  let target = Math.min(1280, Math.max(768, long));
  let s = target / long;
  if (roi.w * roi.h * s * s > 1.25e6) s = Math.sqrt(1.25e6 / (roi.w * roi.h));
  return { w: Math.max(64, Math.round(roi.w * s)), h: Math.max(64, Math.round(roi.h * s)), s };
}

export async function prepareUpload(img, roi) {
  const ws = workSize(roi);
  const canvas = cropToCanvas(img, roi, ws.w, ws.h);
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.93);
  const orig = canvasToImg(canvas);
  canvas.width = 1; canvas.height = 1;
  return { blob, orig, ws };
}

// Similarity transform (scale, rotation, translation) mapping src → dst points.
function similarity(src, dst) {
  const n = src.length;
  let msx = 0; let msy = 0; let mdx = 0; let mdy = 0;
  for (let i = 0; i < n; i++) { msx += src[i][0]; msy += src[i][1]; mdx += dst[i][0]; mdy += dst[i][1]; }
  msx /= n; msy /= n; mdx /= n; mdy /= n;
  let a = 0; let b = 0; let ss = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - msx; const sy = src[i][1] - msy; const dx = dst[i][0] - mdx; const dy = dst[i][1] - mdy;
    a += sx * dx + sy * dy; b += sx * dy - sy * dx; ss += sx * sx + sy * sy;
  }
  const scale = Math.hypot(a, b) / ss;
  const th = Math.atan2(b, a);
  const c = Math.cos(th) * scale; const s = Math.sin(th) * scale;
  const tx = mdx - (c * msx - s * msy); const ty = mdy - (s * msx + c * msy);
  let err = 0;
  for (let i = 0; i < n; i++) {
    const x = c * src[i][0] - s * src[i][1] + tx; const y = s * src[i][0] + c * src[i][1] + ty;
    err += Math.hypot(x - dst[i][0], y - dst[i][1]);
  }
  return { c, s, tx, ty, scale, th, err: err / n };
}

function warp(src, T, w, h) {
  // inverse mapping: dst q → src p = R⁻¹(q − t)/scale
  const det = T.c * T.c + T.s * T.s;
  const out = createImg(w, h);
  const px = [0, 0, 0, 0];
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      const qx = x + 0.5 - T.tx; const qy = y + 0.5 - T.ty;
      const sx = (T.c * qx + T.s * qy) / det; const sy = (-T.s * qx + T.c * qy) / det;
      sampleRGBA(src, sx, sy, px);
      out.data[i] = px[0]; out.data[i + 1] = px[1]; out.data[i + 2] = px[2]; out.data[i + 3] = 255;
    }
  }
  return out;
}

// Build the aligned result and the blend mask, both at work resolution.
export async function composeResult({ feature, resultBlob, orig, roi, ws, face, imageW, imageH }) {
  let res = await blobToImg(resultBlob, 2048);
  res = resizeRGBA(res, ws.w, ws.h);
  const lm = face.landmarks.map(([x, y]) => [(x - roi.x) * ws.s, (y - roi.y) * ws.s]);

  // Align the AI output to the original using stable facial points.
  let aligned = res;
  let alignNote = 'not needed';
  try {
    const found = await detectFaces(res, null, { maxSide: 1024 });
    const m = faceMetrics(lm);
    const match = found.find((f) => {
      const fm = faceMetrics(f.landmarks);
      return Math.hypot(fm.eyeMid[0] - m.eyeMid[0], fm.eyeMid[1] - m.eyeMid[1]) < m.faceW * 0.6;
    });
    if (match) {
      const srcPts = STABLE_POINTS.map((i) => match.landmarks[i]);
      const T = similarity(srcPts, STABLE_POINTS.map((i) => lm[i]));
      let shift = 0;
      for (const [x, y] of srcPts) shift += Math.hypot(T.c * x - T.s * y + T.tx - x, T.s * x + T.c * y + T.ty - y);
      const moved = shift / srcPts.length > 0.75;
      if (T.err < m.faceW * 0.08 && T.scale > 0.85 && T.scale < 1.15 && moved) {
        aligned = warp(res, T, ws.w, ws.h);
        alignNote = 'aligned';
      }
    } else {
      alignNote = 'face not found in result';
    }
  } catch {
    alignNote = 'alignment skipped';
  }

  // Fade the blend toward crop edges that lie inside the photo, so no seam shows.
  const inner = imageW ? {
    left: roi.x > 0, top: roi.y > 0, right: roi.x + roi.w < imageW, bottom: roi.y + roi.h < imageH,
  } : { left: true, top: true, right: true, bottom: true };
  const mask = buildMask(feature, orig, aligned, lm, ws.w, ws.h, inner);
  return { result: aligned, mask, alignNote };
}

function changeMask(a, b, w, h, radius) {
  const n = w * h;
  const d = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const dr = (a.data[i] - b.data[i]) / 255; const dg = (a.data[i + 1] - b.data[i + 1]) / 255; const db = (a.data[i + 2] - b.data[i + 2]) / 255;
    const dy = 0.2126 * dr + 0.7152 * dg + 0.0722 * db;
    d[p] = Math.abs(dy) * 0.7 + (Math.abs(dr - dy) + Math.abs(db - dy)) * 0.5;
  }
  const sm = gaussBlur(d, w, h, 2);
  for (let p = 0; p < n; p++) sm[p] = smoothstep(0.035, 0.09, sm[p]);
  const closed = gaussBlur(sm, w, h, radius);
  for (let p = 0; p < n; p++) closed[p] = smoothstep(0.12, 0.4, closed[p]);
  return closed;
}

export function buildMask(feature, orig, res, lm, w, h, inner = { left: true, top: true, right: true, bottom: true }) {
  const n = w * h;
  const { faceW, eyeMid, chin } = faceMetrics(lm);
  const minDim = Math.min(w, h);
  let m = new Float32Array(n);

  // Face core = the person's own facial features; never replaced for outfit/hair.
  const core = new Float32Array(n);
  fillPolygon(core, w, h, scalePoly(facePolygon(lm, 0.18), 1.02), 1);
  const coreSoft = gaussBlur(core, w, h, Math.max(1, faceW * 0.03));

  if (feature === 'outfit') {
    const protect = new Float32Array(n);
    fillPolygon(protect, w, h, scalePoly(facePolygon(lm, 0.75), 1.06), 1);
    const top = eyeMid[1] - faceW * 1.0; const bottom = eyeMid[1] + (chin[1] - eyeMid[1]) * 0.5;
    fillEllipse(protect, w, h, eyeMid[0], (top + bottom) / 2, faceW * 0.78, (bottom - top) / 2, 1);
    const protectSoft = gaussBlur(protect, w, h, Math.max(1, faceW * 0.035));
    const changed = changeMask(orig, res, w, h, Math.max(3, minDim * 0.03));
    for (let y = 0, p = 0; y < h; y++) {
      const below = smoothstep(chin[1] - faceW * 0.35, chin[1] + faceW * 0.05, y); // clothes start at the jawline
      for (let x = 0; x < w; x++, p++) m[p] = changed[p] * below * (1 - protectSoft[p]);
    }
  } else if (feature === 'hair') {
    const head = new Float32Array(n);
    fillEllipse(head, w, h, eyeMid[0], eyeMid[1] - faceW * 0.15, faceW * 1.05, faceW * 1.25, 1);
    const changed = changeMask(orig, res, w, h, Math.max(3, minDim * 0.025));
    const headSoft = gaussBlur(head, w, h, Math.max(2, faceW * 0.06));
    for (let y = 0, p = 0; y < h; y++) {
      const nearHead = 1 - smoothstep(chin[1] + faceW * 0.8, chin[1] + faceW * 1.6, y);
      for (let x = 0; x < w; x++, p++) {
        const zone = Math.max(headSoft[p], changed[p] * nearHead);
        m[p] = zone * (1 - coreSoft[p]);
      }
    }
  } else { // smile: lower face only, eyes and upper face stay original
    const lower = new Float32Array(n);
    fillPolygon(lower, w, h, scalePoly(facePolygon(lm, 0), 1.04), 1);
    const eyeBottom = Math.max(lm[40][1], lm[41][1], lm[46][1], lm[47][1]);
    const noseTip = lm[33][1];
    const soft = gaussBlur(lower, w, h, Math.max(1, faceW * 0.035));
    for (let y = 0, p = 0; y < h; y++) {
      const ramp = smoothstep(eyeBottom + (noseTip - eyeBottom) * 0.15, noseTip, y);
      for (let x = 0; x < w; x++, p++) m[p] = soft[p] * ramp;
    }
  }

  m = gaussBlur(m, w, h, Math.max(1, minDim * 0.006));
  const band = Math.max(4, minDim * 0.06);
  for (let y = 0, p = 0; y < h; y++) {
    const fy = Math.min(inner.top ? smoothstep(0, band, y) : 1, inner.bottom ? smoothstep(0, band, h - 1 - y) : 1);
    for (let x = 0; x < w; x++, p++) {
      const fx = Math.min(inner.left ? smoothstep(0, band, x) : 1, inner.right ? smoothstep(0, band, w - 1 - x) : 1);
      m[p] *= Math.min(fx, fy);
    }
  }
  if (feature !== 'smile') for (let p = 0; p < n; p++) m[p] *= 1 - smoothstep(0.35, 0.9, coreSoft[p]);
  const out = new Uint8Array(n);
  for (let p = 0; p < n; p++) out[p] = Math.round(Math.min(1, Math.max(0, m[p])) * 255);
  return { width: w, height: h, data: out };
}
