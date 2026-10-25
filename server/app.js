// CAREer Studio HTTP server: static site + JSON API. Node built-ins only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {
  HttpError, sendJson, sendError, readBody, readJson, parseCookies, randomId, clientIp, RateLimiter, sniffImage,
} from './http-utils.js';
import { ReplicateClient } from './replicate.js';
import { AiJobs } from './ai-jobs.js';
import { publicPresetList } from './ai-presets.js';
import { TelegramClient, validateSubmission } from './telegram.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.bin': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.webmanifest']);
const PAGES = { '/': 'index.html', '/editor': 'editor.html', '/projects': 'projects.html', '/profile': 'profile.html', '/privacy': 'privacy.html' };

export function createApp(cfg, deps = {}) {
  const log = deps.log || ((m) => console.log(`[${new Date().toISOString()}] ${m}`));
  const replicate = new ReplicateClient({ ...cfg.replicate, fetchImpl: deps.fetchImpl || fetch });
  const jobs = new AiJobs(cfg, replicate, log);
  const telegram = new TelegramClient({ ...cfg.telegram, fetchImpl: deps.fetchImpl || fetch });
  const aiLimiter = new RateLimiter(cfg.limits.aiPerHourPerIp, 3600 * 1000);
  const contactLimiter = new RateLimiter(cfg.limits.contactPerHourPerIp, 3600 * 1000);
  const staticCache = new Map();

  const sweeper = setInterval(() => { jobs.sweep(); aiLimiter.sweep(); contactLimiter.sweep(); }, 60 * 1000);
  sweeper.unref();

  const csp = [
    "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self'", "img-src 'self' blob: data:",
    "connect-src 'self' blob: data:", "font-src 'self'", "worker-src 'self' blob:", "media-src 'self' blob:",
    `frame-ancestors ${cfg.frameAncestors}`, "base-uri 'self'", "form-action 'self'", "object-src 'none'", "manifest-src 'self'",
  ].join('; ');

  function securityHeaders(res) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (cfg.frameAncestors === "'none'") res.setHeader('X-Frame-Options', 'DENY');
    if (cfg.hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  function session(req, res) {
    const cookies = parseCookies(req);
    let sid = cookies.cs_sid;
    if (!sid || !/^[A-Za-z0-9_-]{20,64}$/.test(sid)) {
      sid = randomId(24);
      res.setHeader('Set-Cookie', `cs_sid=${sid}; Path=/api; HttpOnly; SameSite=Strict${cfg.secureCookies ? '; Secure' : ''}; Max-Age=86400`);
    }
    return sid;
  }

  // CSRF defence for state-changing calls: same-origin + custom header.
  function checkWrite(req) {
    if (req.headers['x-cs-request'] !== '1') throw new HttpError(403, 'forbidden', 'Request blocked.');
    const origin = req.headers.origin;
    if (origin) {
      const allowed = cfg.allowedOrigins.length
        ? cfg.allowedOrigins.includes(origin)
        : (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
      if (!allowed) throw new HttpError(403, 'forbidden', 'Request blocked.');
    }
  }

  async function handleApi(req, res, url) {
    const sid = session(req, res);
    const ip = clientIp(req, cfg.trustProxy);
    const p = url.pathname;

    if (p === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, {
        brand: cfg.brandName,
        ai: { enabled: cfg.aiEnabled, provider: cfg.aiEnabled ? 'Replicate' : null, presets: publicPresetList() },
        contact: { enabled: cfg.telegramEnabled, email: cfg.contactEmail || null },
        limits: { maxUploadBytes: cfg.limits.maxUploadBytes },
        heroImage: fs.existsSync(path.join(cfg.publicDir, 'brand', 'hero.jpg')) ? '/brand/hero.jpg' : null,
      });
    }

    if (p === '/api/ai/jobs' && req.method === 'POST') {
      checkWrite(req);
      if (!cfg.aiEnabled) throw new HttpError(503, 'not_configured', 'AI editing is not set up on this server yet.');
      const feature = url.searchParams.get('feature') || '';
      if (!['outfit', 'smile', 'hair', 'matte', 'background'].includes(feature)) throw new HttpError(400, 'bad_feature', 'Unknown AI feature.');
      const rl = aiLimiter.take(ip);
      if (!rl.ok) throw new HttpError(429, 'rate_limited', `You've reached the hourly AI limit. Try again in ${Math.ceil(rl.retryAfterSec / 60)} min.`);
      let image = null;
      let imageType = null;
      if (feature !== 'background') {
        image = await readBody(req, cfg.limits.maxUploadBytes);
        const info = sniffImage(image);
        if (!info) throw new HttpError(415, 'bad_image', 'Upload a JPEG, PNG or WebP photo.');
        if (info.width && info.height && (info.width < 128 || info.height < 128 || info.width > 4096 || info.height > 4096)) {
          throw new HttpError(422, 'bad_dimensions', 'The photo size is not supported for AI editing.');
        }
        imageType = info.type;
      } else {
        req.resume();
      }
      const job = jobs.create({
        sid, feature, preset: url.searchParams.get('preset') || '', image, imageType, aspect: url.searchParams.get('aspect') || '3:4',
      });
      return sendJson(res, 202, jobs.publicView(job));
    }

    const m = p.match(/^\/api\/ai\/jobs\/([A-Za-z0-9_-]{10,64})(\/result)?$/);
    if (m) {
      const [, id, isResult] = m;
      if (req.method === 'GET' && !isResult) return sendJson(res, 200, jobs.publicView(jobs.get(sid, id)));
      if (req.method === 'GET' && isResult) {
        const out = jobs.takeResult(sid, id);
        res.writeHead(200, { 'Content-Type': out.contentType.startsWith('image/') ? out.contentType : 'application/octet-stream',
          'Content-Length': out.buffer.length, 'Cache-Control': 'no-store' });
        return res.end(out.buffer);
      }
      if (req.method === 'DELETE' && !isResult) {
        checkWrite(req);
        jobs.cancel(sid, id);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (p === '/api/session/delete' && req.method === 'POST') {
      checkWrite(req);
      const purged = jobs.purgeSession(sid);
      res.setHeader('Set-Cookie', `cs_sid=; Path=/api; HttpOnly; SameSite=Strict${cfg.secureCookies ? '; Secure' : ''}; Max-Age=0`);
      return sendJson(res, 200, { ok: true, purgedJobs: purged });
    }

    if (p === '/api/contact' && req.method === 'POST') {
      checkWrite(req);
      if (!cfg.telegramEnabled) throw new HttpError(503, 'not_configured', 'The contact form is not set up yet.');
      const rl = contactLimiter.take(ip);
      if (!rl.ok) throw new HttpError(429, 'rate_limited', 'Too many messages from this connection. Please try again later.');
      const body = await readJson(req, 16 * 1024 * 1024);
      const submission = validateSubmission(body);
      if (submission.bot) return sendJson(res, 200, { ok: true }); // silently drop bots
      await telegram.send(submission, cfg.brandName);
      log(`contact delivered (${submission.kind}${submission.photo ? ', photo' : ''}${submission.cv ? ', cv' : ''})`);
      return sendJson(res, 200, { ok: true });
    }

    throw new HttpError(404, 'not_found', 'Not found.');
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: { code: 'method', message: 'Method not allowed' } });
    let rel = PAGES[url.pathname.replace(/\/$/, '') || '/'] || PAGES[url.pathname];
    if (!rel) {
      let decoded;
      try { decoded = decodeURIComponent(url.pathname); } catch { decoded = ''; }
      if (!decoded || decoded.includes('\0') || decoded.split('/').some((seg) => seg.startsWith('.'))) return notFound(res);
      rel = decoded.replace(/^\/+/, '');
    }
    const file = path.resolve(cfg.publicDir, rel);
    if (!file.startsWith(cfg.publicDir + path.sep)) return notFound(res);
    let stat;
    try { stat = fs.statSync(file); } catch { return notFound(res); }
    if (!stat.isFile()) return notFound(res);
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext];
    if (!type) return notFound(res);

    let entry = staticCache.get(file);
    if (!entry || entry.mtimeMs !== stat.mtimeMs) {
      const raw = fs.readFileSync(file);
      entry = {
        raw, mtimeMs: stat.mtimeMs,
        etag: `"${crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"`,
        gz: COMPRESSIBLE.has(ext) && raw.length > 1024 ? zlib.gzipSync(raw, { level: 9 }) : null,
      };
      staticCache.set(file, entry);
    }
    const longCache = /^(fonts|models|vendor|backgrounds|icons|brand)\//.test(rel);
    res.setHeader('Content-Type', type);
    res.setHeader('ETag', entry.etag);
    res.setHeader('Cache-Control', longCache ? 'public, max-age=604800' : 'no-cache');
    res.setHeader('Vary', 'Accept-Encoding');
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304); return res.end(); }
    const useGz = entry.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const body = useGz ? entry.gz : entry.raw;
    if (useGz) res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', body.length);
    res.writeHead(200);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function notFound(res) {
    const file = path.join(cfg.publicDir, '404.html');
    if (fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }

  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
    try {
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return serveStatic(req, res, url);
    } catch (err) {
      if (!(err instanceof HttpError)) log(`unhandled ${req.method} ${url.pathname}: ${err?.stack || err}`);
      if (!res.headersSent) sendError(res, err); else res.end();
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 30000;
  server.on('close', () => clearInterval(sweeper));
  server.jobs = jobs;
  return server;
}
