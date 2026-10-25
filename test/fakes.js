// TEST-ONLY fakes of the Replicate and Telegram HTTP APIs.
// They let the automated tests exercise the real server code paths (file upload,
// prediction polling, output download, file deletion, Telegram delivery) without
// network access. They are never used by the running app, and the images they
// return are synthetic test patterns — not AI results.
import http from 'node:http';
import zlib from 'node:zlib';
import { sniffImage } from '../server/http-utils.js';

function crc32(buf) {
  let c; const table = crc32.t || (crc32.t = Array.from({ length: 256 }, (_, n) => {
    c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodePng(width, height, pixel /* (x,y) => [r,g,b,a] */) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) { const [r, g, b, a] = pixel(x, y); raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a; }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function readAll(req) {
  return new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
}

function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }

// Extract the first file part from a multipart body (enough for tests).
function firstFilePart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  let start = body.indexOf(boundary);
  while (start >= 0) {
    const next = body.indexOf(boundary, start + boundary.length);
    if (next < 0) break;
    const part = body.subarray(start + boundary.length + 2, next - 2);
    const sep = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, sep).toString();
    if (/filename=/.test(head)) return { head, data: part.subarray(sep + 4) };
    start = next;
  }
  return null;
}

export function startFakeReplicate({ failWith = null, slowPolls = 1 } = {}) {
  const state = { files: new Map(), deleted: [], predictions: new Map(), created: [], canceled: [], authOk: true, failWith };
  let base = '';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (!p.startsWith('/out/') && req.headers.authorization !== 'Bearer test-token') return json(res, 401, { detail: 'Unauthenticated' });
    if (req.method === 'GET' && /^\/v1\/models\/[^/]+\/[^/]+$/.test(p)) return json(res, 200, { latest_version: { id: 'fakeversion123' } });
    if (req.method === 'POST' && p === '/v1/files') {
      const body = await readAll(req);
      const part = firstFilePart(body, req.headers['content-type']);
      const id = `file${state.files.size + 1}`;
      state.files.set(id, part?.data || Buffer.alloc(0));
      return json(res, 201, { id, urls: { get: `${base}/v1/files/${id}` } });
    }
    if (req.method === 'DELETE' && p.startsWith('/v1/files/')) { const id = p.split('/').pop(); state.deleted.push(id); state.files.delete(id); res.writeHead(204); return res.end(); }
    if (req.method === 'POST' && (p === '/v1/predictions' || /^\/v1\/models\/[^/]+\/[^/]+\/predictions$/.test(p))) {
      const body = JSON.parse((await readAll(req)).toString());
      const id = `pred${state.predictions.size + 1}`;
      const model = p === '/v1/predictions' ? `version:${body.version}` : p.split('/').slice(3, 5).join('/');
      const input = body.input || {};
      let dims = { width: 1024, height: 768 };
      const ref = input.input_image || input.image;
      if (typeof ref === 'string') {
        let buf = null;
        if (ref.startsWith('data:')) buf = Buffer.from(ref.split(',')[1], 'base64');
        else { const fid = ref.split('/').pop(); buf = state.files.get(fid); }
        const info = buf && sniffImage(buf);
        if (info?.width) dims = { width: info.width, height: info.height };
      }
      const kind = input.output_format === 'mask' ? 'mask' : ref ? 'edit' : 'background';
      const pred = { id, model, input, status: 'starting', polls: 0, kind, dims };
      state.predictions.set(id, pred);
      state.created.push({ id, model, input: { ...input, input_image: input.input_image ? '[image]' : undefined, image: input.image ? '[image]' : undefined } });
      return json(res, 201, { id, status: 'starting', urls: { get: `${base}/v1/predictions/${id}` } });
    }
    const pm = p.match(/^\/v1\/predictions\/([^/]+)(\/cancel)?$/);
    if (pm) {
      const pred = state.predictions.get(pm[1]);
      if (!pred) return json(res, 404, { detail: 'Not found' });
      if (pm[2]) { pred.status = 'canceled'; state.canceled.push(pred.id); return json(res, 200, { id: pred.id, status: 'canceled' }); }
      if (pred.status !== 'canceled') {
        pred.polls++;
        if (pred.polls > slowPolls) pred.status = state.failWith ? 'failed' : 'succeeded';
        else pred.status = 'processing';
      }
      const out = pred.status === 'succeeded' ? `${base}/out/${pred.id}.png` : null;
      return json(res, 200, { id: pred.id, status: pred.status, output: out, error: pred.status === 'failed' ? state.failWith : null });
    }
    const om = p.match(/^\/out\/(pred\d+)\.png$/);
    if (om) {
      const pred = state.predictions.get(om[1]);
      const { width, height } = pred.dims;
      let png;
      if (pred.kind === 'mask') {
        // synthetic matte: an upright ellipse in the centre
        png = encodePng(width, height, (x, y) => {
          const v = ((x - width / 2) / (width * 0.32)) ** 2 + ((y - height * 0.55) / (height * 0.5)) ** 2 < 1 ? 255 : 0;
          return [v, v, v, 255];
        });
      } else if (pred.kind === 'background') {
        png = encodePng(768, 1024, (x, y) => [120 + (x % 64), 140, 170 + (y % 32), 255]);
      } else {
        // synthetic "edit": navy lower 55%, light grey upper part (no face)
        png = encodePng(width, height, (x, y) => (y > height * 0.45 ? [30, 42, 70, 255] : [210, 210, 210, 255]));
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      return res.end(png);
    }
    json(res, 404, { detail: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve({ server, state, base, apiBase: `${base}/v1`, close: () => new Promise((r) => server.close(r)) });
  }));
}

export function startFakeTelegram() {
  const state = { calls: [] };
  const server = http.createServer(async (req, res) => {
    const body = await readAll(req);
    const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!m || m[1] !== 'tg-test-token') return json(res, 401, { ok: false, description: 'Unauthorized' });
    const call = { method: m[2], contentType: req.headers['content-type'] || '', size: body.length };
    if (call.contentType.startsWith('application/json')) call.json = JSON.parse(body.toString());
    else {
      const part = firstFilePart(body, call.contentType);
      call.fileHead = part?.head; call.fileSize = part?.data.length;
      call.text = body.toString('latin1').match(/name="caption"\r\n\r\n([^\r]*)/)?.[1];
    }
    state.calls.push(call);
    json(res, 200, { ok: true, result: { message_id: state.calls.length } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ server, state, base, close: () => new Promise((r) => server.close(r)) });
  }));
}
