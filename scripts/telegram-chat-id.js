#!/usr/bin/env node
// Prints the chat IDs your bot can see, so you can set TELEGRAM_CHAT_ID.
// 1) Create a bot with @BotFather and put its token in .env as TELEGRAM_BOT_TOKEN.
// 2) Send any message to the bot (or add it to a group and post there).
// 3) Run: npm run telegram:chat-id
import { loadConfig } from '../server/config.js';

const cfg = loadConfig();
if (!cfg.telegram.token) {
  console.error('Set TELEGRAM_BOT_TOKEN in .env first.');
  process.exit(1);
}
const res = await fetch(`${cfg.telegram.apiBase}/bot${cfg.telegram.token}/getUpdates`);
const data = await res.json();
if (!data.ok) {
  console.error('Telegram rejected the token:', data.description);
  process.exit(1);
}
const chats = new Map();
for (const u of data.result) {
  const chat = (u.message || u.channel_post || u.my_chat_member)?.chat;
  if (chat) chats.set(chat.id, chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username);
}
if (!chats.size) console.log('No chats yet. Send your bot a message, then run this again.');
for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID=${id}   # ${name}`);
