#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const server = createApp(cfg);

server.listen(cfg.port, cfg.host, () => {
  console.log(`${cfg.brandName} is running.`);
  console.log(`  Open on this computer:  http://localhost:${cfg.port}`);
  if (cfg.publicOrigin) console.log(`  Public address (when deployed): ${cfg.publicOrigin}`);
  console.log(`  AI editing (Replicate): ${cfg.aiEnabled ? 'enabled' : 'NOT configured — set REPLICATE_API_TOKEN'}`);
  console.log(`  Telegram enquiries:     ${cfg.telegramEnabled ? 'enabled' : 'NOT configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID'}`);
  if (cfg.nodeEnv === 'production' && !cfg.publicOrigin) {
    console.warn('  Warning: set PUBLIC_ORIGIN (e.g. https://careerstudioapp.com) in production.');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
