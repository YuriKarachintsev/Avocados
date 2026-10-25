// Loads configuration from environment variables (and an optional .env file).
// Secrets are read here only and never sent to the browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function num(env, name, fallback) {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function bool(env, name, fallback = false) {
  const v = String(env[name] || '').toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

export function loadConfig(overrides = {}) {
  if (!overrides.skipDotEnv) loadDotEnv(path.join(ROOT, '.env'));
  const env = { ...process.env, ...overrides.env };
  const get = (k, d = '') => (env[k] ?? d);

  const publicOrigin = get('PUBLIC_ORIGIN', '').replace(/\/$/, '');
  const extraOrigins = get('ALLOWED_ORIGINS', '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);

  const cfg = {
    root: ROOT,
    publicDir: path.join(ROOT, 'public'),
    port: Number(get('PORT', '8080')),
    host: get('HOST', '0.0.0.0'),
    nodeEnv: get('NODE_ENV', 'development'),
    publicOrigin,
    allowedOrigins: [publicOrigin, ...extraOrigins].filter(Boolean),
    trustProxy: ['1', 'true', 'yes'].includes(String(get('TRUST_PROXY', '')).toLowerCase()),
    frameAncestors: get('FRAME_ANCESTORS', "'self'"),
    brandName: get('BRAND_NAME', 'CAREer Studio'),
    contactEmail: get('CONTACT_EMAIL', ''),

    replicate: {
      token: get('REPLICATE_API_TOKEN', ''),
      apiBase: get('REPLICATE_API_BASE', 'https://api.replicate.com/v1').replace(/\/$/, ''),
      editModel: get('REPLICATE_EDIT_MODEL', 'black-forest-labs/flux-kontext-pro'),
      matteModel: get('REPLICATE_MATTE_MODEL', 'sprited/birefnet'),
      matteVariant: get('REPLICATE_MATTE_VARIANT', 'portrait'),
      backgroundModel: get('REPLICATE_BACKGROUND_MODEL', 'black-forest-labs/flux-kontext-pro'),
      // Hosts the server may download model outputs from (SSRF protection).
      outputHosts: get('REPLICATE_OUTPUT_HOSTS', 'replicate.delivery,.replicate.delivery,api.replicate.com')
        .split(',').map((s) => s.trim()).filter(Boolean),
      timeoutMs: num(env, 'REPLICATE_TIMEOUT_MS', 150000),
    },

    costs: {
      // Estimated USD per call, used for the daily budget guard. Check current prices.
      edit: num(env, 'COST_EDIT_USD', 0.04),
      matte: num(env, 'COST_MATTE_USD', 0.002),
      background: num(env, 'COST_BACKGROUND_USD', 0.04),
    },
    limits: {
      dailyBudgetUsd: num(env, 'DAILY_AI_BUDGET_USD', 5),
      aiPerHourPerIp: num(env, 'AI_REQUESTS_PER_HOUR_PER_IP', 30),
      contactPerHourPerIp: num(env, 'CONTACT_REQUESTS_PER_HOUR_PER_IP', 5),
      maxConcurrentJobs: num(env, 'MAX_CONCURRENT_AI_JOBS', 4),
      maxUploadBytes: num(env, 'MAX_AI_UPLOAD_BYTES', 8 * 1024 * 1024),
      jobTtlMs: num(env, 'AI_JOB_TTL_MS', 10 * 60 * 1000),
    },

    telegram: {
      token: get('TELEGRAM_BOT_TOKEN', ''),
      chatId: get('TELEGRAM_CHAT_ID', ''),
      apiBase: get('TELEGRAM_API_BASE', 'https://api.telegram.org').replace(/\/$/, ''),
    },
    hsts: bool(env, 'ENABLE_HSTS', publicOrigin.startsWith('https://')),
  };

  cfg.aiEnabled = Boolean(cfg.replicate.token);
  cfg.telegramEnabled = Boolean(cfg.telegram.token && cfg.telegram.chatId);
  cfg.secureCookies = publicOrigin.startsWith('https://');
  return cfg;
}
