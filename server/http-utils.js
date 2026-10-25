// Small HTTP helpers built on node:http only.
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function sendJson(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

export function sendError(res, err) {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message, ...err.extra } });
  } else {
    sendJson(res, 500, { error: { code: 'server_error', message: 'Something went wrong on our side. Please try again.' } });
  }
}

export function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > limitBytes) {
      reject(new HttpError(413, 'too_large', `That file is too large. The limit is ${Math.round(limitBytes / 1048576)} MB.`));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limitBytes) {
        done = true;
        reject(new HttpError(413, 'too_large', `That file is too large. The limit is ${Math.round(limitBytes / 1048576)} MB.`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

export async function readJson(req, limitBytes) {
  const type = String(req.headers['content-type'] || '');
  if (!type.startsWith('application/json')) throw new HttpError(415, 'bad_content_type', 'Expected JSON.');
  const buf = await readBody(req, limitBytes);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json', 'The request could not be read.');
  }
}

export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

// Sliding-window limiter: at most `max` events per `windowMs` per key.
export class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  take(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      const retryMs = this.windowMs - (now - arr[0]);
      return { ok: false, retryAfterSec: Math.ceil(retryMs / 1000) };
    }
    arr.push(now);
    this.hits.set(key, arr);
    return { ok: true };
  }
  sweep(now = Date.now()) {
    for (const [k, arr] of this.hits) {
      const live = arr.filter((t) => now - t < this.windowMs);
      if (live.length) this.hits.set(k, live); else this.hits.delete(k);
    }
  }
}

// Identify image type from magic bytes and read dimensions from headers
// without decoding pixels. Returns null if not a supported image.
export function sniffImage(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { type: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { type: 'image/jpeg', height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + len;
    }
    return { type: 'image/jpeg', width: 0, height: 0 };
  }
  // WebP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    let width = 0; let height = 0;
    if (chunk === 'VP8X' && buf.length >= 30) {
      width = 1 + buf.readUIntLE(24, 3);
      height = 1 + buf.readUIntLE(27, 3);
    } else if (chunk === 'VP8 ' && buf.length >= 30) {
      width = buf.readUInt16LE(26) & 0x3fff;
      height = buf.readUInt16LE(28) & 0x3fff;
    } else if (chunk === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      width = (b & 0x3fff) + 1;
      height = ((b >> 14) & 0x3fff) + 1;
    }
    return { type: 'image/webp', width, height };
  }
  return null;
}

export function sniffDocument(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1) return 'application/msword';
  return null;
}
