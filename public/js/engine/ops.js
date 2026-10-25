// Deterministic editing operations. Each op takes an image and returns a new one,
// so history can be replayed at preview or full resolution.
import {
  clamp01, smoothstep, lum, createImg, cloneImg, resizeMask, resizeRGBA, sampleRGBA, boxBlur, gaussBlur, guidedFilter,
  fillPolygon, fillEllipse, scalePoly, polygonArea,
} from './raster.js';
import {
  faceMetrics, facePolygon, eyePolys, mouthOuter, mouthInner, browPolys, nostrilPoly, scaleLandmarks, boxOf,
} from './face.js';

// ---------------------------------------------------------------- looks
export const LOOKS = {
  natural: { label: 'Natural', p: { contrast: 6, saturation: 4, clarity: 6 } },
  studio: { label: 'Studio', p: { contrast: 14, highlights: -14, shadows: 10, clarity: 12 } },
  warm: { label: 'Warm office', p: { warmth: 16, saturation: 4, highlights: -8, brightness: 4 } },
  cool: { label: 'Corporate cool', p: { warmth: -14, tint: -3, contrast: 10, saturation: -4 } },
  matte: { label: 'Soft matte', p: { contrast: -14, shadows: 24, saturation: -10, highlights: -6 } },
  golden: { label: 'Golden hour', p: { warmth: 26, tint: 5, highlights: -12, vignette: 18, saturation: 6 } },
  crisp: { label: 'Crisp', p: { clarity: 22, sharpen: 30, contrast: 8 } },
  mono: { label: 'Classic B&W', p: { saturation: -100, contrast: 16, clarity: 10 } },
};

export const ADJUSTMENTS = [
  { key: 'brightness', label: 'Brightness', min: -100, max: 100 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
  { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
  { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
  { key: 'warmth', label: 'Warmth', min: -100, max: 100 },
  { key: 'tint', label: 'Tint', min: -100, max: 100 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
  { key: 'clarity', label: 'Clarity', min: -100, max: 100 },
  { key: 'sharpen', label: 'Sharpen', min: 0, max: 100 },
  { key: 'vignette', label: 'Vignette', min: -100, max: 100 },
];

export function applyOp(img, op, ctx) {
  switch (op.type) {
    case 'adjust': return applyAdjust(img, op.params, ctx);
    case 'look': return applyLook(img, op.params, ctx);
    case 'retouch': return applyRetouch(img, op.params, ctx);
    case 'background': return applyBackground(img, op.params, ctx);
    case 'aiComposite': return applyAiComposite(img, op.params, ctx);
    case 'frame': return img; // framing is applied at display/export time
    default: throw new Error(`Unknown op ${op.type}`);
  }
}

// ---------------------------------------------------------------- adjust
export function applyLook(img, { look, intensity = 100 }, ctx) {
  const preset = LOOKS[look];
  if (!preset) return cloneImg(img);
  const k = intensity / 100;
  const p = {};
  for (const [key, v] of Object.entries(preset.p)) p[key] = v * k;
  return applyAdjust(img, p, ctx);
}

export function applyAdjust(img, params) {
  const P = (k) => (params?.[k] || 0) / 100;
  const br = P('brightness'); const co = P('contrast'); const hl = P('highlights'); const sh = P('shadows');
  const wa = P('warmth'); const ti = P('tint'); const sa = P('saturation'); const cl = P('clarity');
  const sp = P('sharpen'); const vg = P('vignette');
  const { width: w, height: h } = img;
  const out = createImg(w, h);
  const s = img.data; const d = out.data;
  const rM = (1 + 0.12 * wa) * (1 + 0.03 * ti); const gM = (1 + 0.02 * wa) * (1 - 0.08 * ti); const bM = (1 - 0.12 * wa) * (1 + 0.03 * ti);
  const bExp = 1 + 1.1 * Math.abs(br);
  const cK = 1 + 0.85 * co;
  const needLocal = Math.abs(cl) > 0.001 || sp > 0.001;
  const Y = needLocal ? new Float32Array(w * h) : null;
  const cx = w / 2; const cy = h / 2; const inv = 1 / Math.hypot(cx, cy);

  // brightness curve via LUT
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    lut[i] = br >= 0 ? 1 - Math.pow(1 - v, bExp) : Math.pow(v, bExp);
  }

  for (let i = 0, p = 0; i < s.length; i += 4, p++) {
    let r = lut[s[i]] * rM; let g = lut[s[i + 1]] * gM; let b = lut[s[i + 2]] * bM;
    if (co !== 0) { r = (r - 0.5) * cK + 0.5; g = (g - 0.5) * cK + 0.5; b = (b - 0.5) * cK + 0.5; }
    let y = lum(r, g, b);
    if (hl !== 0 || sh !== 0) {
      const yc = clamp01(y);
      const dy = 0.24 * (hl * smoothstep(0.45, 1, yc) + sh * (1 - smoothstep(0, 0.55, yc)));
      if (y > 0.004) { const k = (y + dy) / y; r *= k; g *= k; b *= k; } else { r += dy; g += dy; b += dy; }
      y += dy;
    }
    if (sa !== 0) { const k = 1 + sa; r = y + (r - y) * k; g = y + (g - y) * k; b = y + (b - y) * k; }
    if (vg !== 0) {
      const x = p % w; const yy = (p / w) | 0;
      const dd = Math.hypot(x - cx, yy - cy) * inv;
      const f = 1 - vg * 0.5 * smoothstep(0.35, 1.05, dd);
      r *= f; g *= f; b *= f;
    }
    d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255; d[i + 3] = s[i + 3];
    if (Y) Y[p] = lum(d[i], d[i + 1], d[i + 2]) / 255;
  }

  if (needLocal) {
    const minDim = Math.min(w, h);
    let target = null;
    if (Math.abs(cl) > 0.001) {
      const blurY = gaussBlur(Y, w, h, Math.max(2, minDim * 0.012));
      target = new Float32Array(Y.length);
      for (let p = 0; p < Y.length; p++) {
        const y = Y[p];
        target[p] = y + cl * 0.9 * (4 * y * (1 - y)) * (y - blurY[p]);
      }
    }
    const base = target || Y;
    let final = base;
    if (sp > 0.001) {
      const r = Math.max(1, Math.round(minDim / 1600));
      const blurS = boxBlur(boxBlur(base, w, h, r), w, h, r);
      final = new Float32Array(base.length);
      for (let p = 0; p < base.length; p++) final[p] = base[p] + sp * 1.4 * (base[p] - blurS[p]);
    }
    for (let i = 0, p = 0; p < Y.length; i += 4, p++) {
      const y0 = Y[p];
      const y1 = final[p];
      if (y0 > 0.002) {
        const k = y1 / y0;
        d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
      } else {
        const add = (y1 - y0) * 255; d[i] += add; d[i + 1] += add; d[i + 2] += add;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- retouch (face-only)
export const RETOUCH_ITEMS = [
  { key: 'smooth', label: 'Smooth skin', def: 45 },
  { key: 'even', label: 'Even tone', def: 40 },
  { key: 'eyes', label: 'Brighten eyes', def: 35 },
  { key: 'teeth', label: 'Whiten teeth', def: 40 },
  { key: 'underEye', label: 'Under-eyes', def: 40 },
];

export function applyRetouch(img, params, ctx) {
  const face = ctx.faces?.[params.face ?? 0];
  if (!face) return cloneImg(img);
  const s = img.width / ctx.fullWidth;
  const out = cloneImg(img);
  const lmFull = scaleLandmarks(face.landmarks, s);
  const { faceW } = faceMetrics(lmFull);
  if (faceW < 24) return out;

  // Work inside the face's bounding region only.
  const bb = boxOf(facePolygon(lmFull, 0.45));
  const pad = faceW * 0.12;
  const rx = Math.max(0, Math.floor(bb.x - pad)); const ry = Math.max(0, Math.floor(bb.y - pad));
  const rx1 = Math.min(img.width, Math.ceil(bb.x + bb.w + pad)); const ry1 = Math.min(img.height, Math.ceil(bb.y + bb.h + pad));
  const w = rx1 - rx; const h = ry1 - ry;
  if (w < 8 || h < 8) return out;
  const lm = lmFull.map(([x, y]) => [x - rx, y - ry]);
  const n = w * h;

  // Channels in 0–1
  const R = new Float32Array(n); const G = new Float32Array(n); const B = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y + ry) * img.width + (x + rx)) * 4; const p = y * w + x;
      R[p] = img.data[i] / 255; G[p] = img.data[i + 1] / 255; B[p] = img.data[i + 2] / 255;
    }
  }

  // Skin mask: face outline minus eyes, brows, lips and nostrils, gated by skin colour.
  const skin = new Float32Array(n);
  fillPolygon(skin, w, h, facePolygon(lm, 0.3), 1);
  for (const e of eyePolys(lm)) fillPolygon(skin, w, h, scalePoly(e, 1.9), 0);
  for (const b of browPolys(lm, faceW * 0.035)) fillPolygon(skin, w, h, scalePoly(b, 1.15), 0);
  fillPolygon(skin, w, h, scalePoly(mouthOuter(lm), 1.12), 0);
  fillPolygon(skin, w, h, scalePoly(nostrilPoly(lm), 1.2), 0);
  // reference skin colour from cheeks
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
    if (!skin[p]) continue;
    const cb = -0.1146 * R[p] - 0.3854 * G[p] + 0.5 * B[p];
    const cr = 0.5 * R[p] - 0.4542 * G[p] - 0.0458 * B[p];
    const dc = Math.sqrt((cb - mCb) ** 2 + (cr - mCr) ** 2);
    if (cnt) skin[p] *= smoothstep(0.06, 0.025, dc); // 1 for skin-like colour, fading out for hair, glasses, etc.
  }
  const skinM = gaussBlur(skin, w, h, Math.max(1, faceW * 0.02));

  const t = (k) => Math.max(0, Math.min(100, params[k] || 0)) / 100;

  if (t('smooth') > 0) {
    const r = Math.max(2, Math.round(faceW * 0.018));
    const eps = 0.0022;
    const k = t('smooth') * 0.78;
    for (const C of [R, G, B]) {
      const q = guidedFilter(C, C, w, h, r, eps);
      for (let p = 0; p < n; p++) C[p] -= skinM[p] * k * (C[p] - q[p]);
    }
  }

  if (t('even') > 0) {
    // Pull chroma toward its local (skin-only) average; luminance detail untouched.
    const k = t('even') * 0.6;
    const Cb = new Float32Array(n); const Cr = new Float32Array(n); const Yc = new Float32Array(n);
    const wCb = new Float32Array(n); const wCr = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      Yc[p] = 0.2126 * R[p] + 0.7152 * G[p] + 0.0722 * B[p];
      Cb[p] = -0.1146 * R[p] - 0.3854 * G[p] + 0.5 * B[p];
      Cr[p] = 0.5 * R[p] - 0.4542 * G[p] - 0.0458 * B[p];
      wCb[p] = Cb[p] * skinM[p]; wCr[p] = Cr[p] * skinM[p];
    }
    const rad = Math.max(3, faceW * 0.06);
    const den = gaussBlur(skinM, w, h, rad); const nb = gaussBlur(wCb, w, h, rad); const nr = gaussBlur(wCr, w, h, rad);
    for (let p = 0; p < n; p++) {
      if (skinM[p] < 0.01 || den[p] < 0.02) continue;
      const m = skinM[p] * k;
      const cb = Cb[p] + m * (nb[p] / den[p] - Cb[p]);
      const cr = Cr[p] + m * (nr[p] / den[p] - Cr[p]);
      const y = Yc[p];
      R[p] = y + 1.5748 * cr; G[p] = y - 0.1873 * cb - 0.4681 * cr; B[p] = y + 1.8556 * cb;
    }
  }

  if (t('eyes') > 0) {
    const m = new Float32Array(n);
    for (const e of eyePolys(lm)) fillPolygon(m, w, h, scalePoly(e, 1.35), 1);
    const mm = gaussBlur(m, w, h, Math.max(1, faceW * 0.01));
    const Y = new Float32Array(n);
    for (let p = 0; p < n; p++) Y[p] = 0.2126 * R[p] + 0.7152 * G[p] + 0.0722 * B[p];
    const by = gaussBlur(Y, w, h, Math.max(1, faceW * 0.008));
    const k = t('eyes');
    for (let p = 0; p < n; p++) {
      if (mm[p] < 0.01) continue;
      const y = Y[p];
      const y2 = y + mm[p] * k * (0.09 * (1 - y) + 0.55 * (y - by[p]));
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
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
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
      const cx = (e[0][0] + e[3][0]) / 2;
      const bottom = Math.max(e[4][1], e[5][1]);
      fillEllipse(m, w, h, cx, bottom + ew * 0.32, ew * 0.55, ew * 0.24, 1);
    }
    const mm = gaussBlur(m, w, h, Math.max(1, faceW * 0.02));
    const Y = new Float32Array(n);
    for (let p = 0; p < n; p++) Y[p] = 0.2126 * R[p] + 0.7152 * G[p] + 0.0722 * B[p];
    const surround = gaussBlur(Y, w, h, Math.max(2, faceW * 0.05));
    const k = t('underEye');
    for (let p = 0; p < n; p++) {
      const mk = mm[p] * skinM[p];
      if (mk < 0.01) continue;
      const y = Y[p];
      const lift = Math.max(0, surround[p] - y) * 0.75 + 0.02 * (1 - y);
      const f = y > 0.003 ? (y + mk * k * lift) / y : 1;
      R[p] *= f; G[p] *= f; B[p] *= f;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y + ry) * img.width + (x + rx)) * 4; const p = y * w + x;
      out.data[i] = R[p] * 255; out.data[i + 1] = G[p] * 255; out.data[i + 2] = B[p] * 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------- background replacement
export const STUDIO_COLOURS = {
  cream: { label: 'Cream', inner: [246, 238, 229], outer: [222, 207, 192] },
  grey: { label: 'Light grey', inner: [228, 229, 231], outer: [186, 189, 194] },
  blue: { label: 'Soft blue', inner: [214, 224, 235], outer: [160, 178, 199] },
  plum: { label: 'Plum', inner: [124, 82, 94], outer: [72, 40, 50] },
  white: { label: 'White', inner: [252, 252, 251], outer: [236, 235, 233] },
};

export function applyBackground(img, params, ctx) {
  const { width: w, height: h } = img;
  const matte = ctx.assets[params.matte];
  if (!matte) return cloneImg(img);
  const minDim = Math.min(w, h);
  let alpha = resizeMask(matte, w, h);

  const edge = (params.edge || 0) / 100;
  if (edge < 0) {
    const lo = -edge * 0.55;
    for (let p = 0; p < alpha.length; p++) alpha[p] = smoothstep(lo, 1, alpha[p]);
  } else if (edge > 0) {
    alpha = gaussBlur(alpha, w, h, Math.max(1, edge * minDim * 0.006));
  }

  // Estimate the original background behind soft edges (normalised convolution at low res),
  // so hair edges don't keep a halo of the old background.
  const sk = Math.min(1, 640 / Math.max(w, h));
  const sw = Math.max(8, Math.round(w * sk)); const shh = Math.max(8, Math.round(h * sk));
  const small = resizeRGBA(img, sw, shh);
  const aSmall = resizeMask({ width: w, height: h, data: alpha }, sw, shh);
  const bgEst = estimateBackground(small, aSmall, Math.max(3, Math.round(Math.min(sw, shh) * 0.03)));

  // New background at full size.
  const bg = buildBackground(params, ctx, w, h, small, aSmall, bgEst);

  // Optional subtle light matching of the person toward the new scene.
  let shift = [0, 0, 0];
  const lm = (params.light || 0) / 100;
  if (lm > 0) {
    let pr = 0; let pg = 0; let pb = 0; let pn = 0; let br = 0; let bgc = 0; let bb = 0; let bn = 0;
    const step = Math.max(1, Math.floor((w * h) / 40000));
    for (let p = 0; p < w * h; p += step) {
      const i = p * 4;
      if (alpha[p] > 0.9) { pr += img.data[i]; pg += img.data[i + 1]; pb += img.data[i + 2]; pn++; }
      br += bg.data[i]; bgc += bg.data[i + 1]; bb += bg.data[i + 2]; bn++;
    }
    if (pn && bn) {
      shift = [(br / bn - pr / pn) * 0.14 * lm, (bgc / bn - pg / pn) * 0.14 * lm, (bb / bn - pb / pn) * 0.14 * lm];
    }
  }

  const out = createImg(w, h);
  const s = img.data; const d = out.data; const bd = bg.data;
  const fx = sw / w; const fy = shh / h;
  const est = [0, 0, 0, 0];
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      const i = p * 4;
      const a = alpha[p];
      if (a >= 0.995) {
        d[i] = s[i] + shift[0]; d[i + 1] = s[i + 1] + shift[1]; d[i + 2] = s[i + 2] + shift[2]; d[i + 3] = 255;
        continue;
      }
      if (a <= 0.005) {
        d[i] = bd[i]; d[i + 1] = bd[i + 1]; d[i + 2] = bd[i + 2]; d[i + 3] = 255;
        continue;
      }
      sampleRGBA(bgEst, (x + 0.5) * fx, (y + 0.5) * fy, est);
      const ia = 1 / Math.max(a, 0.08);
      const Fr = Math.min(255, Math.max(0, (s[i] - (1 - a) * est[0]) * ia)) + shift[0];
      const Fg = Math.min(255, Math.max(0, (s[i + 1] - (1 - a) * est[1]) * ia)) + shift[1];
      const Fb = Math.min(255, Math.max(0, (s[i + 2] - (1 - a) * est[2]) * ia)) + shift[2];
      d[i] = Fr * a + bd[i] * (1 - a); d[i + 1] = Fg * a + bd[i + 1] * (1 - a); d[i + 2] = Fb * a + bd[i + 2] * (1 - a); d[i + 3] = 255;
    }
  }
  return out;
}

function estimateBackground(small, aSmall, r) {
  const { width: w, height: h, data } = small;
  const n = w * h;
  const wgt = new Float32Array(n); const cr = new Float32Array(n); const cg = new Float32Array(n); const cb = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const k = Math.pow(1 - aSmall[p], 3);
    wgt[p] = k; cr[p] = data[p * 4] * k; cg[p] = data[p * 4 + 1] * k; cb[p] = data[p * 4 + 2] * k;
  }
  let W = wgt; let Rr = cr; let Gg = cg; let Bb = cb;
  // grow the estimate inward over several passes so it covers the person area
  for (let pass = 0; pass < 3; pass++) {
    const rr = r * (pass + 1);
    W = gaussBlur(W, w, h, rr); Rr = gaussBlur(Rr, w, h, rr); Gg = gaussBlur(Gg, w, h, rr); Bb = gaussBlur(Bb, w, h, rr);
  }
  const out = createImg(w, h);
  for (let p = 0; p < n; p++) {
    const k = W[p] > 1e-4 ? 1 / W[p] : 0;
    out.data[p * 4] = k ? Rr[p] * k : data[p * 4];
    out.data[p * 4 + 1] = k ? Gg[p] * k : data[p * 4 + 1];
    out.data[p * 4 + 2] = k ? Bb[p] * k : data[p * 4 + 2];
    out.data[p * 4 + 3] = 255;
  }
  return out;
}

function buildBackground(params, ctx, w, h, small, aSmall, bgEst) {
  const blur = (params.blur || 0) / 100;
  if (params.mode === 'color') {
    const c = STUDIO_COLOURS[params.color] || STUDIO_COLOURS.cream;
    const out = createImg(w, h);
    const cx = w * 0.5; const cy = h * 0.42; const R = Math.hypot(w, h) * 0.62;
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        const t = smoothstep(0, 1, Math.min(1, Math.hypot(x - cx, y - cy) / R));
        const n = ((x * 12.9898 + y * 78.233) % 1) * 1.2 - 0.6; // tiny dither against banding
        out.data[i] = c.inner[0] + (c.outer[0] - c.inner[0]) * t + n;
        out.data[i + 1] = c.inner[1] + (c.outer[1] - c.inner[1]) * t + n;
        out.data[i + 2] = c.inner[2] + (c.outer[2] - c.inner[2]) * t + n;
        out.data[i + 3] = 255;
      }
    }
    return out;
  }
  if (params.mode === 'blur') {
    // Defocus the original scene (with the person removed so no halo bleeds in).
    const k = 0.012 + 0.05 * Math.max(0.15, blur);
    const est = blurRGBA(bgEst, Math.max(1, Math.min(bgEst.width, bgEst.height) * k));
    return resizeRGBA(est, w, h);
  }
  const src = ctx.assets[params.bg];
  if (!src) return resizeRGBA(bgEst, w, h);
  // cover-fit crop of the backdrop
  const scale = Math.max(w / src.width, h / src.height);
  const cw = w / scale; const ch = h / scale;
  const ox = (src.width - cw) / 2; const oy = (src.height - ch) * 0.4;
  if (blur > 0.001) {
    const tw = Math.min(1024, Math.round(cw)); const th = Math.max(1, Math.round(tw * ch / cw));
    const crop = cropResize(src, ox, oy, cw, ch, tw, th);
    const b = blurRGBA(crop, Math.max(1, Math.min(tw, th) * 0.025 * blur));
    return resizeRGBA(b, w, h);
  }
  return cropResize(src, ox, oy, cw, ch, w, h);
}

function cropResize(src, ox, oy, cw, ch, w, h) {
  let s = src;
  // Pre-shrink when the crop is much larger than the target, to avoid aliasing.
  if (cw > 2 * w) {
    const f = (2 * w) / cw;
    s = resizeRGBA(src, Math.max(1, Math.round(src.width * f)), Math.max(1, Math.round(src.height * f)));
    ox *= f; oy *= f; cw *= f; ch *= f;
  }
  const out = createImg(w, h);
  const px = [0, 0, 0, 0];
  const sx = cw / w; const sy = ch / h;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      sampleRGBA(s, ox + (x + 0.5) * sx, oy + (y + 0.5) * sy, px);
      out.data[i] = px[0]; out.data[i + 1] = px[1]; out.data[i + 2] = px[2]; out.data[i + 3] = 255;
    }
  }
  return out;
}

export function blurRGBA(img, sigma) {
  const { width: w, height: h } = img;
  const n = w * h;
  const out = createImg(w, h);
  for (let c = 0; c < 3; c++) {
    const plane = new Float32Array(n);
    for (let p = 0; p < n; p++) plane[p] = img.data[p * 4 + c];
    const b = gaussBlur(plane, w, h, sigma);
    for (let p = 0; p < n; p++) out.data[p * 4 + c] = b[p];
  }
  for (let p = 0; p < n; p++) out.data[p * 4 + 3] = 255;
  return out;
}

// ---------------------------------------------------------------- AI composite
// Blend an aligned AI result into the photo only where its region mask allows.
export function applyAiComposite(img, params, ctx) {
  const res = ctx.assets[params.result]; const mask = ctx.assets[params.mask];
  if (!res || !mask) return cloneImg(img);
  const s = img.width / ctx.fullWidth;
  const out = cloneImg(img);
  const rx = params.roi.x * s; const ry = params.roi.y * s; const rw = params.roi.w * s; const rh = params.roi.h * s;
  const x0 = Math.max(0, Math.floor(rx)); const y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(img.width, Math.ceil(rx + rw)); const y1 = Math.min(img.height, Math.ceil(ry + rh));
  const px = [0, 0, 0, 0];
  const mw = mask.width; const mh = mask.height; const md = mask.data;
  const mScale = md instanceof Float32Array ? 1 : 1 / 255;
  for (let y = y0; y < y1; y++) {
    const v = ((y + 0.5 - ry) / rh);
    for (let x = x0; x < x1; x++) {
      const u = ((x + 0.5 - rx) / rw);
      if (u < 0 || v < 0 || u > 1 || v > 1) continue;
      // mask (bilinear)
      let fx = u * mw - 0.5; let fy = v * mh - 0.5;
      if (fx < 0) fx = 0; if (fy < 0) fy = 0; if (fx > mw - 1) fx = mw - 1; if (fy > mh - 1) fy = mh - 1;
      const mx0 = fx | 0; const my0 = fy | 0; const mx1 = Math.min(mw - 1, mx0 + 1); const my1 = Math.min(mh - 1, my0 + 1);
      const ax = fx - mx0; const ay = fy - my0;
      const top = md[my0 * mw + mx0] + (md[my0 * mw + mx1] - md[my0 * mw + mx0]) * ax;
      const bot = md[my1 * mw + mx0] + (md[my1 * mw + mx1] - md[my1 * mw + mx0]) * ax;
      const m = (top + (bot - top) * ay) * mScale;
      if (m <= 0.003) continue;
      sampleRGBA(res, u * res.width, v * res.height, px);
      const i = (y * img.width + x) * 4;
      out.data[i] = img.data[i] + (px[0] - img.data[i]) * m;
      out.data[i + 1] = img.data[i + 1] + (px[1] - img.data[i + 1]) * m;
      out.data[i + 2] = img.data[i + 2] + (px[2] - img.data[i + 2]) * m;
    }
  }
  return out;
}
