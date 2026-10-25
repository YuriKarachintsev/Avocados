// Server tests: node --test test/server.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { startFakeReplicate, startFakeTelegram, encodePng } from './fakes.js';

const PHOTO = fs.readFileSync(new URL('./fixtures/portrait-2048.jpg', import.meta.url));

async function boot(env = {}) {
  const cfg = loadConfig({
    skipDotEnv: true,
    env: {
      PORT: '0', PUBLIC_ORIGIN: '', REPLICATE_API_TOKEN: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', DAILY_AI_BUDGET_USD: '5', ...env,
    },
  });
  const server = createApp(cfg, { log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (path, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.cookie = cookie;
    if (opts.method && opts.method !== 'GET' && !('X-CS-Request' in headers)) headers['X-CS-Request'] = '1';
    const res = await fetch(base + path, { ...opts, headers });
    const sc = res.headers.get('set-cookie');
    if (sc && sc.startsWith('cs_sid=') && !sc.startsWith('cs_sid=;')) cookie = sc.split(';')[0];
    return res;
  };
  return { cfg, server, base, call, close: () => new Promise((r) => server.close(r)) };
}

async function waitJob(call, id) {
  for (let i = 0; i < 60; i++) {
    const st = await (await call(`/api/ai/jobs/${id}`)).json();
    if (['succeeded', 'failed', 'canceled'].includes(st.status)) return st;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('job did not finish');
}

test('static pages and security headers', async () => {
  const app = await boot();
  try {
    for (const path of ['/', '/editor', '/projects', '/profile', '/privacy']) {
      const res = await app.call(path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.equal((await app.call('/../server/config.js')).status, 404);
    assert.equal((await app.call('/%2e%2e/package.json')).status, 404);
    assert.equal((await app.call('/.env')).status, 404);
    const gz = await fetch(`${app.base}/vendor/face-api/face-api.esm.js`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gz.status, 200);
  } finally { await app.close(); }
});

test('config never exposes secrets', async () => {
  const app = await boot({ REPLICATE_API_TOKEN: 'r8_secret_value', TELEGRAM_BOT_TOKEN: 'tg-secret', TELEGRAM_CHAT_ID: '42' });
  try {
    const text = await (await app.call('/api/config')).text();
    assert.ok(!text.includes('r8_secret_value'));
    assert.ok(!text.includes('tg-secret'));
    const cfg = JSON.parse(text);
    assert.equal(cfg.ai.enabled, true);
    assert.equal(cfg.contact.enabled, true);
    assert.ok(cfg.ai.presets.outfit.find((p) => p.id === 'w-office-navy'));
    assert.ok(cfg.ai.presets.outfit.find((p) => p.id === 'm-smart-oxford'));
  } finally { await app.close(); }
});

test('AI features report "not configured" without a token', async () => {
  const app = await boot();
  try {
    const cfg = await (await app.call('/api/config')).json();
    assert.equal(cfg.ai.enabled, false);
    const res = await app.call('/api/ai/jobs?feature=outfit&preset=w-office-navy', { method: 'POST', body: PHOTO, headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'not_configured');
  } finally { await app.close(); }
});

test('outfit edit: upload → prediction → result, upload deleted afterwards', async () => {
  const rep = await startFakeReplicate();
  const app = await boot({ REPLICATE_API_TOKEN: 'test-token', REPLICATE_API_BASE: rep.apiBase, REPLICATE_OUTPUT_HOSTS: '127.0.0.1' });
  try {
    const res = await app.call('/api/ai/jobs?feature=outfit&preset=m-office-navy', { method: 'POST', body: PHOTO, headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal(res.status, 202);
    const job = await res.json();
    const st = await waitJob(app.call, job.id);
    assert.equal(st.status, 'succeeded');
    const out = await app.call(`/api/ai/jobs/${job.id}/result`);
    assert.equal(out.status, 200);
    assert.equal(out.headers.get('content-type'), 'image/png');
    assert.ok((await out.arrayBuffer()).byteLength > 1000);
    // result is handed over once, then gone
    assert.equal((await app.call(`/api/ai/jobs/${job.id}/result`)).status, 404);
    // the photo went up as a file and was deleted after the prediction
    assert.equal(rep.state.deleted.length, 1);
    assert.equal(rep.state.files.size, 0);
    const created = rep.state.created[0];
    assert.equal(created.model, 'black-forest-labs/flux-kontext-pro');
    assert.match(created.input.prompt, /navy blue suit/);
    assert.match(created.input.prompt, /Keep the person's identity/);
    assert.equal(created.input.aspect_ratio, 'match_input_image');
  } finally { await app.close(); await rep.close(); }
});

test('HD cut-out uses the community model via its latest version', async () => {
  const rep = await startFakeReplicate();
  const app = await boot({ REPLICATE_API_TOKEN: 'test-token', REPLICATE_API_BASE: rep.apiBase, REPLICATE_OUTPUT_HOSTS: '127.0.0.1' });
  try {
    const job = await (await app.call('/api/ai/jobs?feature=matte', { method: 'POST', body: PHOTO, headers: { 'Content-Type': 'image/jpeg' } })).json();
    const st = await waitJob(app.call, job.id);
    assert.equal(st.status, 'succeeded');
    assert.equal(rep.state.created[0].model, 'version:fakeversion123');
    assert.equal(rep.state.created[0].input.output_format, 'mask');
  } finally { await app.close(); await rep.close(); }
});

test('AI background generation sends no photo', async () => {
  const rep = await startFakeReplicate();
  const app = await boot({ REPLICATE_API_TOKEN: 'test-token', REPLICATE_API_BASE: rep.apiBase, REPLICATE_OUTPUT_HOSTS: '127.0.0.1' });
  try {
    const job = await (await app.call('/api/ai/jobs?feature=background&preset=ai-glass&aspect=3:4', { method: 'POST' })).json();
    assert.equal((await waitJob(app.call, job.id)).status, 'succeeded');
    assert.equal(rep.state.files.size + rep.state.deleted.length, 0);
    assert.equal(rep.state.created[0].input.aspect_ratio, '3:4');
    assert.equal(rep.state.created[0].input.input_image, undefined);
  } finally { await app.close(); await rep.close(); }
});

test('free-text prompts are impossible: unknown presets are rejected', async () => {
  const rep = await startFakeReplicate();
  const app = await boot({ REPLICATE_API_TOKEN: 'test-token', REPLICATE_API_BASE: rep.apiBase });
  try {
    const res = await app.call('/api/ai/jobs?feature=outfit&preset=remove%20clothes', { method: 'POST', body: PHOTO, headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal(res.status, 400);
    assert.equal(rep.state.created.length, 0);
    const bad = await app.call('/api/ai/jobs?feature=anything&preset=x', { method: 'POST', body: PHOTO });
    assert.equal(bad.status, 400);
  } finally { await app.close(); await rep.close(); }
});

test('non-images and oversize uploads are refused', async () => {
  const rep = await startFakeReplicate();
  const app = await boot({ REPLICATE_API_TOKEN: 'test-token', REPLICATE_API_BASE: rep.apiBase, MAX_AI_UPLOAD_BYTES: String(64 * 1024) });
  try {
    const txt = await app.call('/api/ai/jobs?feature=outfit&preset=w-office-navy', { method: 'POST', body: Buffer.from('not an image at all, just text'.repeat(10)) });
    assert.equal(txt.status, 415);
    const big = await app.call('/api/ai/jobs?feature=outfit&preset=w-office-navy', { method: 'POST', body: PHOTO });
    assert.equal(big.status, 413);
  } finally { await app.close(); await rep.close(); }
});

test('CSRF: missing header or foreign origin is blocked', async () => {
  const app = await boot({ REPLICATE_API_TOKEN: 'test-token', PUBLIC_ORIGIN: 'https://careerstudioapp.com' });
  try {
    const noHeader = await app.call('/api/session/delete', { method: 'POST', headers: { 'X-CS-Request': undefined } });
    assert.equal(noHeader.status, 403);
    const foreign = await app.call('/api/session/delete', { method: 'POST', headers: { Origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403);
    const ok = await app.call('/api/session/delete', { method: 'POST', headers: { Origin: 'https://careerstudioapp.com' } });
    assert.equal(ok.status, 200);
  } finally { await app.close(); }
});

test('provider failure becomes a friendly error and the upload is still deleted', async () => {
  const rep = await startFakeReplicate({ failWith: 'CUDA out of memory' });
  const app = await boot({ REPLICATE_API_TOKEN: 'test-token', REPLICATE_API_BASE: rep.apiBase, REPLICATE_OUTPUT_HOSTS: '127.0.0.1' });
  try {
    const job = await (await app.call('/api/ai/jobs?feature=hair&preset=tidy', { method: 'POST', body: PHOTO, headers: { 'Content-Type': 'image/jpeg' } })).json();
    const st = await waitJob(app.call, job.id);
    assert.equal(st.status, 'failed');
    assert.equal(st.error.code, 'provider_failed');
    assert.ok(!/CUDA/.test(st.error.message));
    assert.equal(rep.state.deleted.length, 1);
  } finally { await app.close(); await rep.close(); }
});

test('content-filter failures are explained', async () => {
  const rep = await startFakeReplicate({ failWith: 'Prediction flagged as NSFW by safety filter' });
  const app = await boot({ REPLICATE_API_TOKEN: 'test-token', REPLICATE_API_BASE: rep.apiBase, REPLICATE_OUTPUT_HOSTS: '127.0.0.1' });
  try {
    const job = await (await app.call('/api/ai/jobs?feature=smile&preset=soft', { method: 'POST', body: PHOTO, headers: { 'Content-Type': 'image/jpeg' } })).json();
    const st = await waitJob(app.call, job.id);
    assert.equal(st.error.code, 'content_filtered');
  } finally { await app.close(); await rep.close(); }
});

test('output downloads are restricted to allowed hosts (SSRF guard)', async () => {
  const rep = await startFakeReplicate();
  // 127.0.0.1 is NOT in the allow-list here, so the fake's output URL must be refused
  const app = await boot({ REPLICATE_API_TOKEN: 'test-token', REPLICATE_API_BASE: rep.apiBase, REPLICATE_OUTPUT_HOSTS: 'replicate.delivery' });
  try {
    const job = await (await app.call('/api/ai/jobs?feature=outfit&preset=w-office-navy', { method: 'POST', body: PHOTO, headers: { 'Content-Type': 'image/jpeg' } })).json();
    const st = await waitJob(app.call, job.id);
    assert.equal(st.status, 'failed');
  } finally { await app.close(); await rep.close(); }
});

test('cancel and session delete purge jobs; other sessions cannot read them', async () => {
  const rep = await startFakeReplicate({ slowPolls: 50 });
  const app = await boot({ REPLICATE_API_TOKEN: 'test-token', REPLICATE_API_BASE: rep.apiBase, REPLICATE_OUTPUT_HOSTS: '127.0.0.1' });
  try {
    const job = await (await app.call('/api/ai/jobs?feature=outfit&preset=w-office-navy', { method: 'POST', body: PHOTO, headers: { 'Content-Type': 'image/jpeg' } })).json();
    // a different browser (no cookie) cannot see it
    const stranger = await fetch(`${app.base}/api/ai/jobs/${job.id}`);
    assert.equal(stranger.status, 404);
    // a second job while one is running is refused
    const busy = await app.call('/api/ai/jobs?feature=outfit&preset=w-office-navy', { method: 'POST', body: PHOTO, headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal(busy.status, 409);
    await new Promise((r) => setTimeout(r, 600));
    const del = await (await app.call('/api/session/delete', { method: 'POST' })).json();
    assert.equal(del.purgedJobs, 1);
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(rep.state.canceled.length >= 1, 'prediction canceled at the provider');
    assert.equal(rep.state.files.size, 0, 'uploaded copy deleted');
  } finally { await app.close(); await rep.close(); }
});

test('daily budget guard stops AI calls', async () => {
  const rep = await startFakeReplicate();
  const app = await boot({ REPLICATE_API_TOKEN: 'test-token', REPLICATE_API_BASE: rep.apiBase, REPLICATE_OUTPUT_HOSTS: '127.0.0.1', DAILY_AI_BUDGET_USD: '0.05' });
  try {
    const j1 = await (await app.call('/api/ai/jobs?feature=outfit&preset=w-office-navy', { method: 'POST', body: PHOTO, headers: { 'Content-Type': 'image/jpeg' } })).json();
    await waitJob(app.call, j1.id);
    const r2 = await app.call('/api/ai/jobs?feature=outfit&preset=w-office-navy', { method: 'POST', body: PHOTO, headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal(r2.status, 503);
    assert.equal((await r2.json()).error.code, 'daily_limit');
  } finally { await app.close(); await rep.close(); }
});

test('per-IP AI rate limit', async () => {
  const app = await boot({ REPLICATE_API_TOKEN: 'test-token', REPLICATE_API_BASE: 'http://127.0.0.1:9', AI_REQUESTS_PER_HOUR_PER_IP: '2' });
  try {
    for (let i = 0; i < 2; i++) await app.call('/api/ai/jobs?feature=background&preset=nope', { method: 'POST' });
    const r = await app.call('/api/ai/jobs?feature=background&preset=nope', { method: 'POST' });
    assert.equal(r.status, 429);
  } finally { await app.close(); }
});

// ---------------------------------------------------------------- Telegram
const validForm = (extra = {}) => ({
  kind: 'enquiry', name: 'Amira Test', email: 'amira@example.com', phone: '+971 50 000 0000', message: 'I would like a team headshot session.',
  consent: true, website: '', startedAt: Date.now() - 10000, ...extra,
});

test('contact form is delivered to Telegram; token stays server-side', async () => {
  const tg = await startFakeTelegram();
  const app = await boot({ TELEGRAM_BOT_TOKEN: 'tg-test-token', TELEGRAM_CHAT_ID: '-100123', TELEGRAM_API_BASE: tg.base });
  try {
    const res = await app.call('/api/contact', { method: 'POST', body: JSON.stringify(validForm({ message: 'Hello <b>team</b> & co' })), headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 200);
    assert.equal(tg.state.calls.length, 1);
    const msg = tg.state.calls[0];
    assert.equal(msg.method, 'sendMessage');
    assert.equal(msg.json.chat_id, '-100123');
    assert.equal(msg.json.parse_mode, 'HTML');
    assert.match(msg.json.text, /Hello &lt;b&gt;team&lt;\/b&gt; &amp; co/); // escaped
    assert.match(msg.json.text, /Amira Test/);
  } finally { await app.close(); await tg.close(); }
});

test('photos are only sent with the separate photo opt-in', async () => {
  const tg = await startFakeTelegram();
  const app = await boot({ TELEGRAM_BOT_TOKEN: 'tg-test-token', TELEGRAM_CHAT_ID: '1', TELEGRAM_API_BASE: tg.base, CONTACT_REQUESTS_PER_HOUR_PER_IP: '50' });
  const photo = PHOTO.toString('base64');
  try {
    // photo included but no photo consent → refused, nothing sent
    const r1 = await app.call('/api/contact', { method: 'POST', body: JSON.stringify(validForm({ attachPhoto: true, photoConsent: false, photo })), headers: { 'Content-Type': 'application/json' } });
    assert.equal(r1.status, 400);
    assert.ok((await r1.json()).error.fields.photoConsent);
    assert.equal(tg.state.calls.length, 0);
    // photo sent without attachPhoto flag → ignored
    await app.call('/api/contact', { method: 'POST', body: JSON.stringify(validForm({ photo })), headers: { 'Content-Type': 'application/json' } });
    assert.deepEqual(tg.state.calls.map((c) => c.method), ['sendMessage']);
    // explicit opt-in → message + document
    tg.state.calls.length = 0;
    const r3 = await app.call('/api/contact', { method: 'POST', body: JSON.stringify(validForm({ attachPhoto: true, photoConsent: true, photo })), headers: { 'Content-Type': 'application/json' } });
    assert.equal(r3.status, 200);
    assert.deepEqual(tg.state.calls.map((c) => c.method), ['sendMessage', 'sendDocument']);
    assert.equal(tg.state.calls[1].fileSize, PHOTO.length);
    assert.match(tg.state.calls[1].text, /explicit opt-in/);
  } finally { await app.close(); await tg.close(); }
});

test('applications validate role and CV type', async () => {
  const tg = await startFakeTelegram();
  const app = await boot({ TELEGRAM_BOT_TOKEN: 'tg-test-token', TELEGRAM_CHAT_ID: '1', TELEGRAM_API_BASE: tg.base, CONTACT_REQUESTS_PER_HOUR_PER_IP: '50' });
  try {
    const noRole = await app.call('/api/contact', { method: 'POST', body: JSON.stringify(validForm({ kind: 'application' })), headers: { 'Content-Type': 'application/json' } });
    assert.equal(noRole.status, 400);
    const exe = Buffer.from('MZ fake executable').toString('base64');
    const badCv = await app.call('/api/contact', { method: 'POST', body: JSON.stringify(validForm({ kind: 'application', position: 'Designer', cv: { name: 'cv.pdf', data: exe } })), headers: { 'Content-Type': 'application/json' } });
    assert.equal(badCv.status, 400);
    const pdf = Buffer.from('%PDF-1.4\n%fake test pdf\n').toString('base64');
    const ok = await app.call('/api/contact', { method: 'POST', body: JSON.stringify(validForm({ kind: 'application', position: 'Designer', cv: { name: 'My CV.pdf', data: pdf } })), headers: { 'Content-Type': 'application/json' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(tg.state.calls.map((c) => c.method), ['sendMessage', 'sendDocument']);
    assert.match(tg.state.calls[1].fileHead, /filename="My CV\.pdf"/);
  } finally { await app.close(); await tg.close(); }
});

test('bots are silently dropped; invalid input is explained; rate limit applies', async () => {
  const tg = await startFakeTelegram();
  const app = await boot({ TELEGRAM_BOT_TOKEN: 'tg-test-token', TELEGRAM_CHAT_ID: '1', TELEGRAM_API_BASE: tg.base, CONTACT_REQUESTS_PER_HOUR_PER_IP: '2' });
  try {
    const bot = await app.call('/api/contact', { method: 'POST', body: JSON.stringify(validForm({ website: 'http://spam' })), headers: { 'Content-Type': 'application/json' } });
    assert.equal(bot.status, 200);
    assert.equal(tg.state.calls.length, 0);
    const bad = await app.call('/api/contact', { method: 'POST', body: JSON.stringify(validForm({ email: 'nope', consent: false })), headers: { 'Content-Type': 'application/json' } });
    assert.equal(bad.status, 400);
    const fields = (await bad.json()).error.fields;
    assert.ok(fields.email && fields.consent);
    const limited = await app.call('/api/contact', { method: 'POST', body: JSON.stringify(validForm()), headers: { 'Content-Type': 'application/json' } });
    assert.equal(limited.status, 429);
  } finally { await app.close(); await tg.close(); }
});

test('Telegram outage gives a friendly error', async () => {
  const app = await boot({ TELEGRAM_BOT_TOKEN: 'wrong', TELEGRAM_CHAT_ID: '1', TELEGRAM_API_BASE: 'http://127.0.0.1:9' });
  try {
    const res = await app.call('/api/contact', { method: 'POST', body: JSON.stringify(validForm()), headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error.message, /couldn't send/);
  } finally { await app.close(); }
});

test('fake PNG encoder sanity', () => {
  const png = encodePng(2, 2, () => [1, 2, 3, 255]);
  assert.equal(png.readUInt32BE(16), 2);
});
