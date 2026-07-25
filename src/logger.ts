import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const LOG_DIR = resolve(process.cwd(), "logs");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = resolve(LOG_DIR, "bridge.log");

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

function stamp(): string {
  return new Date().toISOString();
}

function write(level: LogLevel, msg: string, extra?: unknown) {
  const line = `[${stamp()}] ${level.padEnd(5)} ${msg}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`;
  console[level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log"](line);
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // best effort
  }
}

export const log = {
  debug: (m: string, x?: unknown) => write("DEBUG", m, x),
  info: (m: string, x?: unknown) => write("INFO", m, x),
  warn: (m: string, x?: unknown) => write("WARN", m, x),
  error: (m: string, x?: unknown) => write("ERROR", m, x),
};

export function tailLog(n = 50): string {
  if (!existsSync(LOG_FILE)) return "";
  const text = readFileSync(LOG_FILE, "utf8");
  return text.split("\n").filter(Boolean).slice(-n).join("\n");
}
