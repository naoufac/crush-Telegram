#!/usr/bin/env bun
// crush-Telegram push tool — send a message from the host to the owner chat
// Usage:
//   bun run src/send.ts "your message"
//   echo "body" | bun run src/send.ts
//   bun run src/send.ts --chat 12345 "to a specific chat"
//
// Reads TELEGRAM_BOT_TOKEN and OWNER_ID from .env (or env).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// tiny inline env loader so this works standalone
const envPath = resolve(process.cwd(), ".env");
try {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
} catch { /* no .env */ }

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER = parseInt(process.env.OWNER_ID ?? "0", 10);

let chatId = OWNER;
const argv = process.argv.slice(2);
const filtered: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--chat" && argv[i + 1]) {
    chatId = parseInt(argv[i + 1], 10);
    i++;
  } else {
    filtered.push(argv[i]);
  }
}

let text = filtered.join(" ");
if (!text) {
  // read from stdin
  try {
    const stdin = readFileSync(0, "utf8");
    text = stdin.trim();
  } catch { /* no stdin */ }
}

if (!TOKEN) { console.error("TELEGRAM_BOT_TOKEN not set"); process.exit(1); }
if (!chatId) { console.error("OWNER_ID not set and no --chat given"); process.exit(1); }
if (!text) { console.error("no message provided (pass text or pipe stdin)"); process.exit(1); }

const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
});
const json = await res.json() as { ok: boolean; description?: string };
if (!json.ok) { console.error("send failed:", json.description); process.exit(2); }
console.log("sent to", chatId);
