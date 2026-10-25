// Low-level raster helpers. Images are { width, height, data: Uint8ClampedArray (RGBA) }.
// Masks are { width, height, data: Uint8Array (0–255) } or plain Float32Array (0–1) during processing.

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function createImg(width, height, data) {
  return { width, height, data: data || new Uint8ClampedArray(width * height * 4) };
}

export function cloneImg(img) {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

// Bilinear sample of an RGBA image at float coords (pixel centres at +0.5).
export function sampleRGBA(src, x, y, out) {
  const w = src.width; const h = src.height; const d = src.data;
  let fx = x - 0.5; let fy = y - 0.5;
  if (fx < 0) fx = 0; if (fy < 0) fy = 0;
  if (fx > w - 1) fx = w - 1; if (fy > h - 1) fy = h - 1;
  const x0 = fx | 0; const y0 = fy | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0; const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const ax = fx - x0; const ay = fy - y0;
  const i00 = (y0 * w + x0) * 4; const i10 = (y0 * w + x1) * 4; const i01 = (y1 * w + x0) * 4; const i11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const top = d[i00 + c] + (d[i10 + c] - d[i00 + c]) * ax;
    const bot = d[i01 + c] + (d[i11 + c] - d[i01 + c]) * ax;
    out[c] = top + (bot - top) * ay;
  }
  return out;
}

export function resizeRGBA(src, w2, h2) {
  if (src.width === w2 && src.height === h2) return cloneImg(src);
  // Pre-shrink with box averaging when reducing a lot, to avoid aliasing.
  let s = src;
  while (s.width / 2 >= w2 && s.height / 2 >= h2) s = halve(s);
  const out = createImg(w2, h2);
  const sx = s.width / w2; const sy = s.height / h2;
  const px = [0, 0, 0, 0];
  let o = 0;
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      sampleRGBA(s, (x + 0.5) * sx, (y + 0.5) * sy, px);
      out.data[o++] = px[0]; out.data[o++] = px[1]; out.data[o++] = px[2]; out.data[o++] = px[3];
    }
  }
  return out;
}

function halve(src) {
  const w = src.width >> 1; const h = src.height >> 1;
  const out = createImg(w, h);
  const s = src.data; const d = out.data; const sw = src.width;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y * 2) * sw + x * 2) * 4; const j = i + sw * 4; const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) d[o + c] = (s[i + c] + s[i + 4 + c] + s[j + c] + s[j + 4 + c] + 2) >> 2;
    }
  }
  return out;
}

// Resample a single-channel mask (Uint8 0–255 or Float32 0–1) to Float32 0–1 at w2×h2.
export function resizeMask(mask, w2, h2) {
  const { width: w, height: h, data } = mask;
  const scale = data instanceof Float32Array ? 1 : 1 / 255;
  const out = new Float32Array(w2 * h2);
  const sx = w / w2; const sy = h / h2;
  let o = 0;
  for (let y = 0; y < h2; y++) {
    let fy = (y + 0.5) * sy - 0.5; if (fy < 0) fy = 0; if (fy > h - 1) fy = h - 1;
    const y0 = fy | 0; const y1 = y0 + 1 < h ? y0 + 1 : y0; const ay = fy - y0;
    for (let x = 0; x < w2; x++) {
      let fx = (x + 0.5) * sx - 0.5; if (fx < 0) fx = 0; if (fx > w - 1) fx = w - 1;
      const x0 = fx | 0; const x1 = x0 + 1 < w ? x0 + 1 : x0; const ax = fx - x0;
      const a = data[y0 * w + x0]; const b = data[y0 * w + x1]; const c = data[y1 * w + x0]; const d = data[y1 * w + x1];
      const top = a + (b - a) * ax; const bot = c + (d - c) * ax;
      out[o++] = (top + (bot - top) * ay) * scale;
    }
  }
  return out;
}

// Separable box blur on a Float32 plane, radius r, edge-normalised.
export function boxBlur(src, w, h, r, out) {
  r = Math.max(0, Math.round(r));
  if (!out) out = new Float32Array(w * h);
  if (r === 0) { out.set(src); return out; }
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0; let n = 0;
    for (let x = 0; x <= r && x < w; x++) { acc += src[row + x]; n++; }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / n;
      const add = x + r + 1; const rem = x - r;
      if (add < w) { acc += src[row + add]; n++; }
      if (rem >= 0) { acc -= src[row + rem]; n--; }
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0; let n = 0;
    for (let y = 0; y <= r && y < h; y++) { acc += tmp[y * w + x]; n++; }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      const add = y + r + 1; const rem = y - r;
      if (add < h) { acc += tmp[add * w + x]; n++; }
      if (rem >= 0) { acc -= tmp[rem * w + x]; n--; }
    }
  }
  return out;
}

// Three box passes ≈ Gaussian with sigma ≈ r.
export function gaussBlur(src, w, h, sigma) {
  const r = Math.max(1, Math.round(sigma * 0.95));
  const a = boxBlur(src, w, h, r);
  const b = boxBlur(a, w, h, r);
  return boxBlur(b, w, h, r, a);
}

// Guided filter (He et al.) with a single-channel guide I and input p.
export function guidedFilter(I, p, w, h, r, eps) {
  const n = w * h;
  const Ip = new Float32Array(n); const II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxBlur(I, w, h, r); const mp = boxBlur(p, w, h, r);
  const mIp = boxBlur(Ip, w, h, r); const mII = boxBlur(II, w, h, r);
  const a = Ip; const b = II;
  for (let i = 0; i < n; i++) {
    const varI = mII[i] - mI[i] * mI[i];
    const cov = mIp[i] - mI[i] * mp[i];
    a[i] = cov / (varI + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxBlur(a, w, h, r); const mb = boxBlur(b, w, h, r);
  const q = mI;
  for (let i = 0; i < n; i++) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

// Fill a polygon into a Float32 plane (value 1), coordinates relative to the plane.
export function fillPolygon(plane, w, h, pts, value = 1) {
  if (pts.length < 3) return plane;
  let minY = Infinity; let maxY = -Infinity;
  for (const [, y] of pts) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const y0 = Math.max(0, Math.floor(minY)); const y1 = Math.min(h - 1, Math.ceil(maxY));
  const xs = [];
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i]; const [xj, yj] = pts[j];
      if ((yi > cy) !== (yj > cy)) xs.push(xi + ((cy - yi) / (yj - yi)) * (xj - xi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.round(xs[k])); const xb = Math.min(w, Math.round(xs[k + 1]));
      for (let x = xa; x < xb; x++) plane[y * w + x] = value;
    }
  }
  return plane;
}

export function fillEllipse(plane, w, h, cx, cy, rx, ry, value = 1) {
  const y0 = Math.max(0, Math.floor(cy - ry)); const y1 = Math.min(h - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / ry;
    const span = 1 - dy * dy;
    if (span <= 0) continue;
    const dx = Math.sqrt(span) * rx;
    const xa = Math.max(0, Math.round(cx - dx)); const xb = Math.min(w, Math.round(cx + dx));
    for (let x = xa; x < xb; x++) plane[y * w + x] = value;
  }
  return plane;
}

export function scalePoly(pts, k) {
  let cx = 0; let cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= pts.length; cy /= pts.length;
  return pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a / 2);
}

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
