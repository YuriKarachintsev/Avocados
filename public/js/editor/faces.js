// On-device face finding with face-api (MIT, TensorFlow.js). No photo leaves the device.
import { cropToCanvas } from './imageio.js';

let faceapi = null;
let loading = null;
let ssdLoaded = false;

export async function loadFaceModels() {
  if (faceapi) return faceapi;
  if (!loading) {
    loading = (async () => {
      const mod = await import('../../vendor/face-api/face-api.esm.js');
      const tf = mod.tf;
      try {
        await tf.setBackend('webgl');
        await tf.ready();
      } catch {
        await tf.setBackend('cpu');
        await tf.ready();
      }
      await Promise.all([
        mod.nets.tinyFaceDetector.loadFromUri('/models'),
        mod.nets.faceLandmark68Net.loadFromUri('/models'),
      ]);
      faceapi = mod;
      return mod;
    })().catch((err) => { loading = null; throw err; });
  }
  return loading;
}

export function getTf() { return faceapi?.tf; }

// Detect faces on a downscaled copy; returns landmarks in full-resolution coordinates.
export async function detectFaces(img, region = null, { maxSide = 1024 } = {}) {
  const api = await loadFaceModels();
  const r = region || { x: 0, y: 0, w: img.width, h: img.height };
  const s = Math.min(1, maxSide / Math.max(r.w, r.h));
  const cw = Math.max(1, Math.round(r.w * s)); const ch = Math.max(1, Math.round(r.h * s));
  const canvas = cropToCanvas(img, r, cw, ch);
  let results = await api.detectAllFaces(canvas, new api.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.55 })).withFaceLandmarks();
  if (!results.length) {
    if (!ssdLoaded) { await api.nets.ssdMobilenetv1.loadFromUri('/models'); ssdLoaded = true; }
    results = await api.detectAllFaces(canvas, new api.SsdMobilenetv1Options({ minConfidence: 0.5 })).withFaceLandmarks();
  }
  canvas.width = 1; canvas.height = 1;
  const faces = results.map((res) => {
    const pts = res.landmarks.positions.map((p) => [r.x + p.x / s, r.y + p.y / s]);
    const b = res.detection.box;
    return { landmarks: pts, box: { x: r.x + b.x / s, y: r.y + b.y / s, w: b.width / s, h: b.height / s }, score: res.detection.score };
  });
  faces.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
  return faces;
}
