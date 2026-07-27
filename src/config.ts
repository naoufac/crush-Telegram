import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotenv(path: string) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // .env is authoritative for this dedicated process: it wins over any
    // inherited env (e.g. a workspace-wide TELEGRAM_BOT_TOKEN from another bot).
    process.env[key] = val;
  }
}

loadDotenv(resolve(process.cwd(), ".env"));

function need(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[config] Missing required env ${key}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

function opt(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

export const config = {
  botToken: need("TELEGRAM_BOT_TOKEN"),
  ownerId: parseInt(need("OWNER_ID"), 10),
  dashPort: opt("DASH_PORT") ? parseInt(opt("DASH_PORT"), 10) : 0,
  dashKey: opt("DASH_KEY"),
  crushCwd: opt("CRUSH_CWD", "/root"),
  crushYolo: opt("CRUSH_YOLO", "false").toLowerCase() === "true",
  crushTimeout: parseInt(opt("CRUSH_TIMEOUT", "600"), 10),
  crushModel: opt("CRUSH_MODEL", ""),
  // The crush *server* this bridge talks to over HTTP+SSE (the real
  // client/server architecture). Same data-dir as the terminal so sessions
  // are shared and any old session can be loaded/continued from Telegram.
  crushServerPort: parseInt(opt("CRUSH_SERVER_PORT", "23917"), 10),
  // When true, auto-allow every tool permission (no Allow/Deny prompts in TG).
  // Defaults to true to match a terminal whose config has allowed_tools:["*"]
  // (tools run freely, no per-action prompts) — the common crush setup. Set
  // CRUSH_AUTO_ALLOW=false to surface Allow/Deny buttons for each tool call.
  crushAutoAllow: opt("CRUSH_AUTO_ALLOW", "true").toLowerCase() === "true",
};

export type Config = typeof config;
