// Geometry derived from the 68-point face landmark layout
// (jaw 0–16, brows 17–26, nose 27–35, eyes 36–47, mouth 48–67).
import { dist } from './raster.js';

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

export function scaleLandmarks(lm, s, ox = 0, oy = 0) {
  return lm.map(([x, y]) => [x * s - ox, y * s - oy]);
}

export function faceMetrics(lm) {
  const faceW = dist(lm[0], lm[16]);
  const eyeL = centroid(range(36, 41).map((i) => lm[i]));
  const eyeR = centroid(range(42, 47).map((i) => lm[i]));
  const eyeMid = [(eyeL[0] + eyeR[0]) / 2, (eyeL[1] + eyeR[1]) / 2];
  const chin = lm[8];
  const faceH = dist(eyeMid, chin) * 1.9;
  const angle = Math.atan2(eyeR[1] - eyeL[1], eyeR[0] - eyeL[0]);
  const center = [(lm[0][0] + lm[16][0] + chin[0] + eyeMid[0]) / 4, (eyeMid[1] + chin[1]) / 2];
  return { faceW, faceH, eyeL, eyeR, eyeMid, chin, angle, center };
}

export function centroid(pts) {
  let x = 0; let y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

// Face outline: jaw line plus an estimated forehead arc above the brows.
export function facePolygon(lm, foreheadK = 0.3) {
  const { faceW, angle } = faceMetrics(lm);
  const up = [Math.sin(angle) * faceW * foreheadK, -Math.cos(angle) * faceW * foreheadK];
  const jaw = range(0, 16).map((i) => lm[i]);
  const brows = range(17, 26).reverse().map((i) => [lm[i][0] + up[0], lm[i][1] + up[1]]);
  return [...jaw, ...brows];
}

export const eyePolys = (lm) => [range(36, 41).map((i) => lm[i]), range(42, 47).map((i) => lm[i])];
export const mouthOuter = (lm) => range(48, 59).map((i) => lm[i]);
export const mouthInner = (lm) => range(60, 67).map((i) => lm[i]);

export function browPolys(lm, thickness) {
  const band = (ids) => {
    const top = ids.map((i) => [lm[i][0], lm[i][1] - thickness]);
    const bottom = ids.slice().reverse().map((i) => [lm[i][0], lm[i][1] + thickness]);
    return [...top, ...bottom];
  };
  return [band(range(17, 21)), band(range(22, 26))];
}

export function nostrilPoly(lm) {
  return [lm[31], lm[32], lm[33], lm[34], lm[35], [lm[35][0], lm[30][1]], [lm[31][0], lm[30][1]]];
}

// Points that stay put across expression/hair/outfit edits — used for alignment.
export const STABLE_POINTS = [27, 28, 29, 30, 31, 33, 35, 36, 39, 42, 45];

export function boxOf(lm) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of lm) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
