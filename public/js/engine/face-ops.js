// Face-only, on-device edits: skin (retouch + Fresh/Silk/Cute), makeup and face shape.
// All work inside the selected face's region and leave every other pixel untouched.
import {
  smoothstep, cloneImg, gaussBlur, guidedFilter, fillPolygon, fillEllipse, scalePoly, polygonArea, sampleRGBA,
} from './raster.js';
import { faceMetrics, eyePolys, mouthOuter, mouthInner, browPolys, nostrilPoly, scaleLandmarks, boxOf } from './face.js';
import {
  prepareFaceRegion, skinMask, writeBack, toY, toCb, toCr, fromYCC, hexToYCC, strokePolyline, gaussianBlob,
} from './face-region.js';

const clamp100 = (v) => Math.max(0, Math.min(100, v || 0)) / 100;

// ---------------------------------------------------------------- skin
export const RETOUCH_ITEMS = [
  { key: 'smooth', label: 'Smooth skin', def: 45 },
  { key: 'even', label: 'Even tone', def: 40 },
  { key: 'eyes', label: 'Brighten eyes', def: 35 },
  { key: 'teeth', label: 'Whiten teeth', def: 40 },
  { key: 'underEye', label: 'Under-eyes', def: 40 },
];

export const SKIN_LOOKS = {
  fresh: { label: 'Fresh', p: { even: 45, radiance: 60, eyes: 30, underEye: 40, smooth: 25 } },
  silk: { label: 'Silk', p: { smooth: 72, glow: 55, even: 35 } },
  cute: { label: 'Cute', p: { smooth: 40, rosy: 60, eyes: 40, radiance: 30, glow: 25 } },
};

function cheekApples(lm, faceW) {
  const at = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const l = at(lm[31], lm[2], 0.55); const r = at(lm[35], lm[14], 0.55);
  l[1] -= faceW * 0.04; r[1] -= faceW * 0.04;
  return [l, r];
}

export function applyRetouch(img, params, ctx) {
  const face = ctx.faces?.[params.face ?? 0];
  if (!face) return cloneImg(img);
  const out = cloneImg(img);
  const reg = prepareFaceRegion(img, face, ctx);
  if (!reg) return out;
  const { w, h, n, lm, faceW, R, G, B } = reg;
  const t = (k) => clamp100(params[k]);
  const skinM = skinMask(reg);

  if (t('smooth') > 0) {
    const r = Math.max(2, Math.round(faceW * 0.018));
    const k = t('smooth') * 0.78;
    for (const C of [R, G, B]) {
      const q = guidedFilter(C, C, w, h, r, 0.0022);
      for (let p = 0; p < n; p++) C[p] -= skinM[p] * k * (C[p] - q[p]);
    }
  }

  if (t('even') > 0) {
    const k = t('even') * 0.6;
    const Cb = new Float32Array(n); const Cr = new Float32Array(n); const Yc = new Float32Array(n);
    const wCb = new Float32Array(n); const wCr = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      Yc[p] = toY(R[p], G[p], B[p]); Cb[p] = toCb(R[p], G[p], B[p]); Cr[p] = toCr(R[p], G[p], B[p]);
      wCb[p] = Cb[p] * skinM[p]; wCr[p] = Cr[p] * skinM[p];
    }
    const rad = Math.max(3, faceW * 0.06);
    const den = gaussBlur(skinM, w, h, rad); const nb = gaussBlur(wCb, w, h, rad); const nr = gaussBlur(wCr, w, h, rad);
    for (let p = 0; p < n; p++) {
      if (skinM[p] < 0.01 || den[p] < 0.02) continue;
      const m = skinM[p] * k;
      const [r, g, b] = fromYCC(Yc[p], Cb[p] + m * (nb[p] / den[p] - Cb[p]), Cr[p] + m * (nr[p] / den[p] - Cr[p]));
      R[p] = r; G[p] = g; B[p] = b;
    }
  }

  if (t('glow') > 0) { // Silk: soft-focus luminous finish on skin only
    const k = t('glow') * 0.5;
    const Y = new Float32Array(n);
    for (let p = 0; p < n; p++) Y[p] = toY(R[p], G[p], B[p]);
    const bY = gaussBlur(Y, w, h, Math.max(2, faceW * 0.03));
    for (let p = 0; p < n; p++) {
      const m = skinM[p] * k;
      if (m < 0.005) continue;
      const y = Y[p]; const y2 = y + m * (Math.max(y, bY[p]) - y + 0.025 * (1 - y));
      const f = y > 0.003 ? y2 / y : 1;
      R[p] *= f; G[p] *= f; B[p] *= f;
    }
  }

  if (t('radiance') > 0) { // Fresh: healthy lift and a touch more colour
    const k = t('radiance');
    for (let p = 0; p < n; p++) {
      const m = skinM[p] * k;
      if (m < 0.005) continue;
      const y = toY(R[p], G[p], B[p]); const cb = toCb(R[p], G[p], B[p]); const cr = toCr(R[p], G[p], B[p]);
      const y2 = Math.min(1, y * (1 + 0.06 * m) + 0.02 * m * (1 - y));
      const [r, g, b] = fromYCC(y2, cb * (1 + 0.08 * m), cr * (1 + 0.1 * m));
      R[p] = r; G[p] = g; B[p] = b;
    }
  }

  if (t('rosy') > 0) { // Cute: soft rosy cheeks
    const k = t('rosy');
    const blob = new Float32Array(n);
    for (const [cx, cy] of cheekApples(lm, faceW)) gaussianBlob(blob, w, h, cx, cy, faceW * 0.12, faceW * 0.085);
    for (let p = 0; p < n; p++) {
      const m = skinM[p] * (blob[p] * k + 0.15 * k);
      if (m < 0.005) continue;
      const y = toY(R[p], G[p], B[p]);
      const [r, g, b] = fromYCC(y, toCb(R[p], G[p], B[p]) - 0.008 * m, toCr(R[p], G[p], B[p]) + 0.04 * m);
      R[p] = r; G[p] = g; B[p] = b;
    }
  }

  if (t('eyes') > 0) {
    const m = new Float32Array(n);
    for (const e of eyePolys(lm)) fillPolygon(m, w, h, scalePoly(e, 1.35), 1);
    const mm = gaussBlur(m, w, h, Math.max(1, faceW * 0.01));
    const Y = new Float32Array(n);
    for (let p = 0; p < n; p++) Y[p] = toY(R[p], G[p], B[p]);
    const by = gaussBlur(Y, w, h, Math.max(1, faceW * 0.008));
    const k = t('eyes');
    for (let p = 0; p < n; p++) {
      if (mm[p] < 0.01) continue;
      const y = Y[p]; const y2 = y + mm[p] * k * (0.09 * (1 - y) + 0.55 * (y - by[p]));
      const f = y > 0.003 ? y2 / y : 1;
      R[p] *= f; G[p] *= f; B[p] *= f;
    }
  }

  if (t('teeth') > 0) {
    const inner = mouthInner(lm);
    if (polygonArea(inner) > faceW * faceW * 0.002) {
      const m = new Float32Array(n);
      fillPolygon(m, w, h, scalePoly(inner, 1.05), 1);
      const mm = gaussBlur(m, w, h, Math.max(1, faceW * 0.006));
      const k = t('teeth');
      for (let p = 0; p < n; p++) {
        if (mm[p] < 0.01) continue;
        const r = R[p]; const g = G[p]; const b = B[p];
        const y = toY(r, g, b); const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
        const sat = mx > 0 ? (mx - mn) / mx : 0;
        const tw = smoothstep(0.32, 0.6, y) * (1 - smoothstep(0.28, 0.55, sat)) * mm[p] * k;
        const yy = Math.min(1, y * (1 + 0.1 * tw));
        R[p] = r + (yy - r) * tw * 0.65; G[p] = g + (yy - g) * tw * 0.65; B[p] = b + (yy * 1.01 - b) * tw * 0.75;
      }
    }
  }

  if (t('underEye') > 0) {
    const m = new Float32Array(n);
    for (const e of eyePolys(lm)) {
      const ew = Math.hypot(e[3][0] - e[0][0], e[3][1] - e[0][1]);
      fillEllipse(m, w, h, (e[0][0] + e[3][0]) / 2, Math.max(e[4][1], e[5][1]) + ew * 0.32, ew * 0.55, ew * 0.24, 1);
    }
    const mm = gaussBlur(m, w, h, Math.max(1, faceW * 0.02));
    const Y = new Float32Array(n);
    for (let p = 0; p < n; p++) Y[p] = toY(R[p], G[p], B[p]);
    const surround = gaussBlur(Y, w, h, Math.max(2, faceW * 0.05));
    const k = t('underEye');
    for (let p = 0; p < n; p++) {
      const mk = mm[p] * skinM[p];
      if (mk < 0.01) continue;
      const y = Y[p]; const lift = Math.max(0, surround[p] - y) * 0.75 + 0.02 * (1 - y);
      const f = y > 0.003 ? (y + mk * k * lift) / y : 1;
      R[p] *= f; G[p] *= f; B[p] *= f;
    }
  }

  writeBack(out, img, reg);
  return out;
}

// ---------------------------------------------------------------- makeup
export const MAKEUP_ITEMS = [
  { key: 'lipstick', label: 'Lipstick', def: 55, colors: [['Nude', '#b97c6c'], ['Rose', '#bf5468'], ['Berry', '#8a2e4c'], ['Classic red', '#ad1830'], ['Coral', '#d9604c']] },
  { key: 'blush', label: 'Blush', def: 45, colors: [['Peach', '#f0a07c'], ['Pink', '#ec8ea2'], ['Rose', '#cf6a7e'], ['Bronze', '#c4845b']] },
  { key: 'contour', label: 'Contouring', def: 45 },
  { key: 'brows', label: 'Eyebrows', def: 50, colors: [['Soft brown', '#6b4a36'], ['Dark brown', '#3b2a20'], ['Taupe', '#7a6a5e'], ['Black', '#1c1a1a']] },
  { key: 'lashes', label: 'Eyelashes', def: 55 },
];

export function applyMakeup(img, params, ctx) {
  const face = ctx.faces?.[params.face ?? 0];
  if (!face) return cloneImg(img);
  const out = cloneImg(img);
  const reg = prepareFaceRegion(img, face, ctx, { pad: 0.15 });
  if (!reg) return out;
  const { w, h, n, lm, faceW, R, G, B } = reg;
  const amt = (k) => clamp100(params[k]?.a);
  const col = (k, fallback) => hexToYCC(params[k]?.c || fallback);
  const skinM = (amt('blush') || amt('contour')) ? skinMask(reg) : null;

  // Recolour inside a mask: match the shade's lightness relative to the area's average,
  // so texture and highlights stay but dark shades really darken.
  const tint = (mask, k, [yc, cbc, crc], { lumPull = 0.35, chroma = 0.85 } = {}) => {
    let sy = 0; let sw = 0;
    for (let p = 0; p < n; p++) { if (mask[p] > 0.3) { sy += toY(R[p], G[p], B[p]) * mask[p]; sw += mask[p]; } }
    const meanY = sw ? sy / sw : 0.5;
    const ratio = Math.min(1.6, Math.max(0.3, yc / Math.max(0.05, meanY)));
    for (let p = 0; p < n; p++) {
      const m = mask[p] * k;
      if (m < 0.004) continue;
      const y = toY(R[p], G[p], B[p]);
      const y2 = Math.min(1, y * (1 + (ratio - 1) * m * lumPull));
      const [r, g, b] = fromYCC(y2, toCb(R[p], G[p], B[p]) * (1 - m * chroma) + cbc * m * chroma,
        toCr(R[p], G[p], B[p]) * (1 - m * chroma) + crc * m * chroma);
      R[p] = r; G[p] = g; B[p] = b;
    }
  };

  if (amt('contour') > 0) {
    const k = amt('contour');
    const shade = new Float32Array(n); const light = new Float32Array(n);
    const at = (a, b, s) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
    const tw = faceW * 0.06;
    // under the cheekbones: from near the ear towards the mouth corner
    strokePolyline(shade, w, h, [at(lm[1], lm[31], 0.05), at(lm[2], lm[48], 0.45)], [tw * 1.3, tw * 0.6]);
    strokePolyline(shade, w, h, [at(lm[15], lm[35], 0.05), at(lm[14], lm[54], 0.45)], [tw * 1.3, tw * 0.6]);
    // jaw edges
    strokePolyline(shade, w, h, [at(lm[3], lm[30], 0.04), at(lm[5], lm[30], 0.04), at(lm[7], lm[57], 0.05)], [tw, tw, tw * 0.5]);
    strokePolyline(shade, w, h, [at(lm[13], lm[30], 0.04), at(lm[11], lm[30], 0.04), at(lm[9], lm[57], 0.05)], [tw, tw, tw * 0.5]);
    // sides of the nose
    const side = faceW * 0.055;
    strokePolyline(shade, w, h, [[lm[27][0] - side, lm[27][1]], [lm[31][0] - side * 0.2, lm[30][1]]], [tw * 0.35, tw * 0.3]);
    strokePolyline(shade, w, h, [[lm[27][0] + side, lm[27][1]], [lm[35][0] + side * 0.2, lm[30][1]]], [tw * 0.35, tw * 0.3]);
    // highlights: cheekbone tops and nose bridge
    strokePolyline(light, w, h, [at(lm[1], lm[36], 0.35), at(lm[2], lm[31], 0.5)], [tw * 0.8, tw * 0.4]);
    strokePolyline(light, w, h, [at(lm[15], lm[45], 0.35), at(lm[14], lm[35], 0.5)], [tw * 0.8, tw * 0.4]);
    strokePolyline(light, w, h, [lm[27], lm[30]], [tw * 0.3, tw * 0.25]);
    const s = gaussBlur(shade, w, h, Math.max(2, faceW * 0.035));
    const l = gaussBlur(light, w, h, Math.max(2, faceW * 0.03));
    for (let p = 0; p < n; p++) {
      const ms = s[p] * skinM[p] * k; const ml = l[p] * skinM[p] * k;
      if (ms < 0.004 && ml < 0.004) continue;
      const y = toY(R[p], G[p], B[p]); const cb = toCb(R[p], G[p], B[p]); const cr = toCr(R[p], G[p], B[p]);
      const y2 = y * (1 - 0.17 * ms) + 0.07 * ml * (1 - y);
      const [r, g, b] = fromYCC(y2, cb - 0.006 * ms, cr + 0.008 * ms);
      R[p] = r; G[p] = g; B[p] = b;
    }
  }

  if (amt('blush') > 0) {
    const blob = new Float32Array(n);
    for (const [cx, cy] of cheekApples(lm, faceW)) gaussianBlob(blob, w, h, cx, cy, faceW * 0.12, faceW * 0.08);
    for (let p = 0; p < n; p++) blob[p] *= skinM[p];
    tint(blob, amt('blush') * 0.6, col('blush', '#f0a07c'), { lumPull: 0.1, chroma: 0.5 });
  }

  if (amt('brows') > 0) {
    const m = new Float32Array(n);
    for (const b of browPolys(lm, faceW * 0.022)) fillPolygon(m, w, h, b, 1);
    const mm = gaussBlur(m, w, h, Math.max(1, faceW * 0.007));
    tint(mm, amt('brows') * 0.75, col('brows', '#3b2a20'), { lumPull: 0.55, chroma: 0.6 });
  }

  if (amt('lashes') > 0) {
    const m = new Float32Array(n);
    const k = amt('lashes');
    const lift = faceW * 0.003;
    const up = (p) => [p[0], p[1] - lift];
    const wing = (outer, inner) => {
      const dx = outer[0] - inner[0]; const dy = outer[1] - inner[1]; const L = Math.hypot(dx, dy) || 1;
      return [outer[0] + (dx / L) * faceW * 0.03, outer[1] + (dy / L) * faceW * 0.03 - faceW * 0.018];
    };
    const base = faceW * (0.008 + 0.008 * k);
    // person's right eye: 39 (inner) → 38 → 37 → 36 (outer); left eye: 42 (inner) → 43 → 44 → 45 (outer)
    strokePolyline(m, w, h, [up(lm[39]), up(lm[38]), up(lm[37]), up(lm[36]), wing(lm[36], lm[39])], [base * 0.4, base * 0.8, base, base * 1.1, base * 0.2]);
    strokePolyline(m, w, h, [up(lm[42]), up(lm[43]), up(lm[44]), up(lm[45]), wing(lm[45], lm[42])], [base * 0.4, base * 0.8, base, base * 1.1, base * 0.2]);
    const mm = gaussBlur(m, w, h, Math.max(0.8, faceW * 0.0025));
    for (let p = 0; p < n; p++) {
      const a = mm[p] * k * 0.9;
      if (a < 0.004) continue;
      const y = toY(R[p], G[p], B[p]);
      const y2 = y + (0.04 - y) * a;
      const f = y > 0.003 ? y2 / y : 1;
      R[p] = R[p] * f * (1 - a * 0.3) + y2 * a * 0.3; G[p] = G[p] * f * (1 - a * 0.3) + y2 * a * 0.3; B[p] = B[p] * f * (1 - a * 0.3) + y2 * a * 0.3;
    }
  }

  if (amt('lipstick') > 0) {
    const m = new Float32Array(n);
    fillPolygon(m, w, h, mouthOuter(lm), 1);
    const inner = mouthInner(lm);
    if (polygonArea(inner) > faceW * faceW * 0.0008) fillPolygon(m, w, h, inner, 0);
    const mm = gaussBlur(m, w, h, Math.max(1, faceW * 0.006));
    tint(mm, amt('lipstick'), col('lipstick', '#bf5468'), { lumPull: 0.85, chroma: 0.9 });
  }

  writeBack(out, img, reg);
  return out;
}

// ---------------------------------------------------------------- face shape (local warp)
export const SHAPE_ITEMS = [
  { key: 'small', label: 'Small face', def: 40 },
  { key: 'cheek', label: 'Cheekbones', def: 40 },
  { key: 'chin', label: 'Defined chin', def: 40 },
];

export function applyReshape(img, params, ctx) {
  const face = ctx.faces?.[params.face ?? 0];
  if (!face) return cloneImg(img);
  const s = img.width / ctx.fullWidth;
  const lm = scaleLandmarks(face.landmarks, s);
  const { faceW } = faceMetrics(lm);
  if (faceW < 24) return cloneImg(img);
  const a = (k) => clamp100(params[k]);
  const cx = (lm[27][0] + lm[8][0]) / 2;
  const ctrl = []; // { x, y, dx, dy, sg }
  if (a('small') > 0) {
    const k = a('small');
    for (let i = 2; i <= 14; i++) {
      if (i === 8) continue;
      const wgt = i >= 4 && i <= 12 ? 1 : 0.6;
      ctrl.push({ x: lm[i][0], y: lm[i][1], dx: (cx - lm[i][0]) * 0.075 * k * wgt, dy: -faceW * 0.006 * k * wgt, sg: faceW * 0.12 });
    }
  }
  if (a('cheek') > 0) {
    const k = a('cheek');
    const at = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    for (const [jaw, mouth] of [[2, 48], [14, 54]]) {
      const [x, y] = at(lm[jaw], lm[mouth], 0.35);
      ctrl.push({ x, y, dx: (cx - x) * 0.06 * k, dy: -faceW * 0.012 * k, sg: faceW * 0.09 });
    }
  }
  if (a('chin') > 0) {
    const k = a('chin');
    ctrl.push({ x: lm[8][0], y: lm[8][1], dx: 0, dy: faceW * 0.03 * k, sg: faceW * 0.08 });
    for (const i of [6, 7, 9, 10]) {
      const wgt = i === 7 || i === 9 ? 1 : 0.6;
      ctrl.push({ x: lm[i][0], y: lm[i][1], dx: (lm[8][0] - lm[i][0]) * 0.12 * k * wgt, dy: faceW * 0.012 * k * wgt, sg: faceW * 0.07 });
    }
  }
  if (!ctrl.length) return cloneImg(img);

  const bb = boxOf(lm);
  const pad = faceW * 0.45;
  const x0 = Math.max(0, Math.floor(bb.x - pad)); const y0 = Math.max(0, Math.floor(bb.y - pad));
  const x1 = Math.min(img.width, Math.ceil(bb.x + bb.w + pad)); const y1 = Math.min(img.height, Math.ceil(bb.y + bb.h + pad));
  const w = x1 - x0; const h = y1 - y0;

  // Keep eyes, brows, nose and mouth rigid so features don't distort.
  const protect = new Float32Array(w * h);
  const loc = lm.map(([x, y]) => [x - x0, y - y0]);
  for (const e of eyePolys(loc)) fillPolygon(protect, w, h, scalePoly(e, 2.2), 1);
  for (const b of browPolys(loc, faceW * 0.04)) fillPolygon(protect, w, h, b, 1);
  fillPolygon(protect, w, h, scalePoly(mouthOuter(loc), 1.25), 1);
  fillPolygon(protect, w, h, scalePoly([loc[27], loc[31], loc[33], loc[35]], 1.4), 1);
  fillPolygon(protect, w, h, scalePoly(nostrilPoly(loc), 1.3), 1);
  const prot = gaussBlur(protect, w, h, Math.max(2, faceW * 0.03));

  // Displacement on a coarse grid, then bilinear per pixel; zero at the region border.
  const step = Math.max(2, Math.round(faceW / 80));
  const gw = Math.ceil(w / step) + 1; const gh = Math.ceil(h / step) + 1;
  const DX = new Float32Array(gw * gh); const DY = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const px = x0 + gx * step; const py = y0 + gy * step;
      let dx = 0; let dy = 0;
      for (const c of ctrl) {
        const d2 = (px - c.x) ** 2 + (py - c.y) ** 2;
        const wv = Math.exp(-d2 / (2 * c.sg * c.sg));
        dx += c.dx * wv; dy += c.dy * wv;
      }
      const edge = Math.min(gx * step, gy * step, w - gx * step, h - gy * step) / (faceW * 0.2);
      const fe = smoothstep(0, 1, Math.min(1, Math.max(0, edge)));
      DX[gy * gw + gx] = dx * fe; DY[gy * gw + gx] = dy * fe;
    }
  }
  const out = cloneImg(img);
  const px = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    const fy = y / step; const gy0 = Math.min(gh - 2, Math.floor(fy)); const ay = fy - gy0;
    for (let x = 0; x < w; x++) {
      const fx = x / step; const gx0 = Math.min(gw - 2, Math.floor(fx)); const ax = fx - gx0;
      const i00 = gy0 * gw + gx0; const i10 = i00 + 1; const i01 = i00 + gw; const i11 = i01 + 1;
      const k = 1 - prot[y * w + x] * 0.85;
      const dx = ((DX[i00] * (1 - ax) + DX[i10] * ax) * (1 - ay) + (DX[i01] * (1 - ax) + DX[i11] * ax) * ay) * k;
      const dy = ((DY[i00] * (1 - ax) + DY[i10] * ax) * (1 - ay) + (DY[i01] * (1 - ax) + DY[i11] * ax) * ay) * k;
      if (Math.abs(dx) < 0.02 && Math.abs(dy) < 0.02) continue;
      sampleRGBA(img, x0 + x + 0.5 - dx, y0 + y + 0.5 - dy, px);
      const o = ((y0 + y) * img.width + (x0 + x)) * 4;
      out.data[o] = px[0]; out.data[o + 1] = px[1]; out.data[o + 2] = px[2];
    }
  }
  return out;
}
