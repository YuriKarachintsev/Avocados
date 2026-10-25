// End-to-end browser test: upload → edit → compare → download, AI paths (against
// TEST-ONLY fakes of Replicate/Telegram), Projects, contact form and deletion.
// Run: npm i -D playwright && npx playwright install chromium && npm run test:e2e
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { startFakeReplicate, startFakeTelegram } from './fakes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PHOTO = path.join(here, 'fixtures/portrait-2048.jpg');
const TWO = path.join(here, 'fixtures/two-people.jpg');
const OUT = process.env.E2E_OUT || path.join(here, 'e2e-output');
fs.mkdirSync(OUT, { recursive: true });
const only = process.argv[2]; // 'desktop' | 'mobile'

async function startApp(env) {
  const cfg = loadConfig({ skipDotEnv: true, env: { PUBLIC_ORIGIN: '', ...env } });
  const server = createApp(cfg, { log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function waitFor(page, fn, arg, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg)) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for: ${fn}`);
}
const idle = async (page, t) => { await page.waitForTimeout(300); await waitFor(page, () => document.getElementById('busy').hidden, null, t); await page.waitForTimeout(300); };

// Mean absolute RGB difference between two full-resolution states inside a box (fractions of face box or image).
const regionDiff = (page, region) => page.evaluate(({ region: r }) => {
  const S = window.__cs.S; const a = window.__snap; const b = S.full.data; const W = S.fullW;
  let sum = 0; let n = 0;
  for (let y = Math.round(r.y0); y < Math.round(r.y1); y += 2) {
    for (let x = Math.round(r.x0); x < Math.round(r.x1); x += 2) {
      const i = (y * W + x) * 4;
      sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n += 3;
    }
  }
  return sum / n;
}, { region });
const snap = (page) => page.evaluate(() => { window.__snap = new Uint8ClampedArray(window.__cs.S.full.data); });
const faceBox = (page) => page.evaluate(() => {
  const f = window.__cs.S.faces[window.__cs.S.face].landmarks;
  const xs = f.map((p) => p[0]); const ys = f.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
});

async function run(name, ctxOpts) {
  const rep = await startFakeReplicate();
  const tg = await startFakeTelegram();
  const app = await startApp({
    REPLICATE_API_TOKEN: 'test-token', REPLICATE_API_BASE: rep.apiBase, REPLICATE_OUTPUT_HOSTS: '127.0.0.1',
    TELEGRAM_BOT_TOKEN: 'tg-test-token', TELEGRAM_CHAT_ID: '-1001', TELEGRAM_API_BASE: tg.base,
  });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ acceptDownloads: true, ...ctxOpts });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/404 \(Not Found\)/.test(m.text())) problems.push(`console: ${m.text()}`); });
  const shot = (s) => page.screenshot({ path: path.join(OUT, `${name}-${s}.png`) });

  try {
    log(name, 'home → editor');
    await page.goto(`${app.base}/`);
    await page.click('a.btn-cta');
    await page.waitForURL('**/editor');

    log(name, 'upload');
    await page.setInputFiles('#file-input', PHOTO);
    await waitFor(page, () => !!(window.__cs?.S.history && document.getElementById('busy').hidden && document.querySelector('.tile')));
    assert.equal(await page.evaluate(() => window.__cs.S.faces.length), 1, 'one face found');
    assert.deepEqual(await page.evaluate(() => [window.__cs.S.fullW, window.__cs.S.fullH]), [2048, 2048], 'full resolution kept');
    const fb = await faceBox(page);
    const fw = fb.x1 - fb.x0; const fh = fb.y1 - fb.y0;
    const inner = { x0: fb.x0 + fw * 0.25, x1: fb.x1 - fw * 0.25, y0: fb.y0 + fh * 0.3, y1: fb.y1 - fh * 0.2 };
    const corner = { x0: 0, x1: 200, y0: 0, y1: 200 };

    log(name, 'retouch (face only)');
    await snap(page);
    await page.click('.tile:has-text("Smooth skin")');
    await page.waitForTimeout(800);
    await page.click('.tile:has-text("Even tone")');
    await page.waitForTimeout(800);
    await page.click('#confirm-row .apply');
    await idle(page);
    assert.ok(await regionDiff(page, inner) > 0.3, 'retouch changed the face');
    assert.equal(await regionDiff(page, corner), 0, 'retouch left the background untouched');

    log(name, 'light look');
    await page.click('#tool-light');
    await page.click('.tile:has-text("Warm office")');
    await page.waitForTimeout(800);
    await page.click('#confirm-row .apply');
    await idle(page);

    log(name, 'outfit via AI (fake service)');
    await page.click('#tool-outfit');
    await page.click('.segmented button:text-is("Men\'s styles")');
    await snap(page);
    await page.click('.tile:has-text("Navy suit")');
    await page.waitForSelector('.modal');
    await shot('consent');
    assert.match(await page.textContent('.modal'), /Replicate/);
    await page.click('.modal .btn-shine');
    await idle(page, 240000);
    await waitFor(page, () => window.__cs.S.pending?.type === 'aiComposite');
    await shot('outfit-pending');
    await page.click('#confirm-row .apply');
    await idle(page);
    assert.equal(await regionDiff(page, inner), 0, 'outfit kept the original face pixels exactly');
    const torso = { x0: 1024 - fw * 0.5, x1: 1024 + fw * 0.5, y0: Math.min(2040, fb.y1 + fh * 1.2), y1: Math.min(2047, fb.y1 + fh * 1.8) };
    assert.ok(await regionDiff(page, torso) > 20, 'outfit changed the clothing area');
    assert.equal(rep.state.files.size, 0, 'no uploaded photo copies remain at the AI provider');

    log(name, 'background: HD cut-out (fake) + studio colour');
    await page.click('#tool-background');
    await page.click('.segmented button:has-text("HD")');
    await snap(page);
    await page.click('.tile:has-text("Cream")');
    await idle(page, 240000);
    await waitFor(page, () => window.__cs.S.pending?.type === 'background');
    await page.click('#confirm-row .apply');
    await idle(page);
    assert.ok(await regionDiff(page, corner) > 5, 'background replaced in the corner');

    log(name, 'AI office backdrop (no photo sent)');
    const filesBefore = rep.state.created.filter((c) => c.input.input_image || c.input.image).length;
    await page.click('.tile:has-text("Meeting room")');
    await idle(page, 240000);
    await waitFor(page, () => window.__cs.S.pending?.type === 'background');
    assert.equal(rep.state.created.filter((c) => c.input.input_image || c.input.image).length, filesBefore, 'no photo sent for AI backdrop');
    await page.click('#confirm-row .apply');
    await idle(page);

    log(name, 'compare + split');
    await page.dispatchEvent('#btn-compare', 'pointerdown');
    assert.equal(await page.evaluate(() => window.__cs.S.view.holding), true, 'hold shows original');
    await shot('compare-hold');
    await page.dispatchEvent('#btn-compare', 'pointerup');
    await page.click('#btn-split');
    await shot('split');
    await page.click('#btn-split');

    log(name, 'crop CV 3:4');
    await page.click('#tool-crop');
    await page.click('.tile:has-text("CV 3:4")');
    await page.click('#confirm-row .apply');
    await idle(page);

    log(name, 'undo / redo / reset');
    const ptr = () => page.evaluate(() => window.__cs.S.history.pointer);
    const p0 = await ptr();
    await page.click('#btn-undo'); await idle(page);
    assert.equal(await ptr(), p0 - 1);
    await page.click('#btn-redo'); await idle(page);
    assert.equal(await ptr(), p0);
    await page.click('#btn-more');
    await page.click('#m-reset'); await idle(page);
    assert.equal(await page.evaluate(() => window.__cs.S.history.hasEdits()), false, 'reset back to original');
    await page.click('#btn-undo'); await idle(page);
    assert.equal(await page.evaluate(() => window.__cs.S.history.hasEdits()), true, 'reset can be undone');

    log(name, 'download');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-download')]);
    const file = path.join(OUT, `${name}-download.jpg`);
    await dl.saveAs(file);
    const buf = fs.readFileSync(file);
    const { sniffImage } = await import('../server/http-utils.js');
    const info = sniffImage(buf);
    assert.equal(info.type, 'image/jpeg');
    assert.deepEqual([info.width, info.height], [1536, 2048], 'CV 3:4 download at full resolution');
    assert.ok(!buf.includes(Buffer.from('Exif')), 'no EXIF metadata in the download');
    await shot('final');

    log(name, 'save to projects');
    await page.click('#btn-more');
    await page.click('#m-save');
    await page.waitForSelector('.toast:has-text("Saved to Projects")');

    log(name, 'contact form with explicit photo opt-in → Telegram (fake)');
    page.removeAllListeners('dialog');
    await page.goto(`${app.base}/profile`);
    await page.click('[data-kind="application"]');
    await page.fill('#f-name', 'Layla Test');
    await page.fill('#f-email', 'layla@example.com');
    await page.fill('#f-position', 'HR Coordinator');
    await page.fill('#f-message', 'Please consider my application.');
    await page.click('#pick-project');
    await page.waitForSelector('#photo-preview:not([hidden])');
    await page.check('#f-consent');
    await page.waitForTimeout(2600); // humans take a moment; the server drops instant submissions
    await page.click('#submit');
    await page.waitForSelector('#data-err-photoConsent, [data-err="photoConsent"]:not(:empty)');
    assert.equal(tg.state.calls.length, 0, 'nothing sent without photo opt-in');
    await page.check('#f-photo-consent');
    await page.click('#submit');
    await page.waitForSelector('#form-status.ok');
    assert.deepEqual(tg.state.calls.map((c) => c.method), ['sendMessage', 'sendDocument']);
    assert.match(tg.state.calls[0].json.text, /HR Coordinator/);
    await shot('contact-sent');

    log(name, 'projects + delete everything');
    await page.goto(`${app.base}/projects`);
    await page.waitForSelector('.project');
    await shot('projects');
    await page.goto(`${app.base}/profile#data`);
    await page.click('#delete-everything');
    await page.click('.modal .btn-danger');
    await page.waitForSelector('.toast:has-text("deleted")');
    await page.goto(`${app.base}/projects`);
    await page.waitForSelector('#empty:not([hidden])');

    log(name, 'group photo: face selection');
    await page.goto(`${app.base}/editor`);
    await page.setInputFiles('#file-input', TWO);
    await waitFor(page, () => !!(window.__cs?.S.history && document.getElementById('busy').hidden && document.querySelector('.tile')));
    assert.equal(await page.evaluate(() => window.__cs.S.faces.length), 2, 'two faces found');
    await page.click('.face-box:not(.selected)');
    assert.equal(await page.evaluate(() => window.__cs.S.face), 1, 'second face selected');
    await shot('two-faces');

    log(name, 'delete photo');
    await page.click('#btn-more');
    await page.click('#m-delete');
    await page.click('.modal .btn-danger');
    await page.waitForSelector('#upload:not([hidden])');

    assert.deepEqual(problems, [], 'no page errors');
    log(name, 'PASS');
  } finally {
    await browser.close();
    await app.close(); await rep.close(); await tg.close();
  }
}

async function runUnconfigured() {
  const app = await startApp({ REPLICATE_API_TOKEN: '', TELEGRAM_BOT_TOKEN: '' });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await page.goto(`${app.base}/editor`);
    await page.setInputFiles('#file-input', PHOTO);
    await waitFor(page, () => !!(window.__cs?.S.history && document.getElementById('busy').hidden && document.querySelector('.tile')));
    await page.click('#tool-outfit');
    assert.match(await page.textContent('.unavailable'), /needs the AI service/);
    await page.click('#tool-background');
    assert.equal(await page.isDisabled('.segmented button:has-text("HD")'), true);
    await page.goto(`${app.base}/profile`);
    await page.waitForSelector('#contact-off:not([hidden])');
    assert.equal(await page.isDisabled('#submit'), true);
    log('unconfigured', 'PASS');
  } finally { await browser.close(); await app.close(); }
}

const t0 = Date.now();
if (!only || only === 'desktop') await run('desktop', { viewport: { width: 1366, height: 860 } });
if (!only || only === 'mobile') await run('mobile', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
if (!only || only === 'unconfigured') await runUnconfigured();
log(`all e2e checks passed in ${Math.round((Date.now() - t0) / 1000)} s`);
