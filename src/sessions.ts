import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { server, type SessionMeta } from "./server-client.ts";
import { log } from "./logger.ts";

const DATA_DIR = resolve(process.cwd(), "data");
const SESSIONS_DIR = resolve(DATA_DIR, "sessions");
if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });

interface StoredSession {
  sessionId: string | null;
  firstMessage: string;
  updatedAt: number;
}

const keyFor = (chatId: number) => resolve(SESSIONS_DIR, `${chatId}.json`);

export function getSession(chatId: number): StoredSession {
  const p = keyFor(chatId);
  if (!existsSync(p)) return { sessionId: null, firstMessage: "", updatedAt: 0 };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as StoredSession;
  } catch {
    return { sessionId: null, firstMessage: "", updatedAt: 0 };
  }
}

export function setSession(chatId: number, sessionId: string | null, firstMessage?: string) {
  const prev = getSession(chatId);
  const updated: StoredSession = {
    sessionId,
    firstMessage: firstMessage ?? prev.firstMessage,
    updatedAt: Date.now(),
  };
  writeFileSync(keyFor(chatId), JSON.stringify(updated, null, 2));
}

export function clearSession(chatId: number) {
  setSession(chatId, null, "");
}

// Ensure this chat has a live session id to send to. Creates one on first use.
export async function ensureSessionId(chatId: number): Promise<string> {
  const stored = getSession(chatId);
  if (stored.sessionId) {
    // Validate it still exists on the server; if not, drop and recreate.
    try {
      await server.getSession(stored.sessionId);
      return stored.sessionId;
    } catch {
      log.warn("stored session gone, creating fresh", { chatId, old: stored.sessionId });
    }
  }
  const title = stored.firstMessage
    ? stored.firstMessage.slice(0, 60)
    : `Telegram chat ${chatId}`;
  const s = await server.createSession(title);
  setSession(chatId, s.id, stored.firstMessage || undefined);
  return s.id;
}

// Bind this chat to an existing session (load/continue any old session).
export async function loadSession(chatId: number, sessionId: string): Promise<boolean> {
  try {
    const s = await server.getSession(sessionId);
    setSession(chatId, s.id, s.title);
    return true;
  } catch {
    return false;
  }
}

// Create a brand-new session for this chat (/new).
export async function newSession(chatId: number): Promise<string> {
  const s = await server.createSession(`Telegram chat ${chatId}`);
  setSession(chatId, s.id, undefined);
  return s.id;
}

export async function recentChatSessions(limit = 12): Promise<Array<{ chatId: number } & StoredSession>> {
  if (!existsSync(SESSIONS_DIR)) return [];
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => {
      try {
        const s = JSON.parse(readFileSync(resolve(SESSIONS_DIR, f), "utf8")) as StoredSession;
        return { chatId: parseInt(f.replace(/\.json$/, ""), 10), ...s };
      } catch {
        return null;
      }
    })
    .filter((x): x is { chatId: number } & StoredSession => x !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

// Dashboard view: newest crush sessions (terminal + telegram) via the server.
export async function listCrushSessions(limit = 12): Promise<Array<{ id: string; title?: string; updatedAt: number }>> {
  let sessions: SessionMeta[] = [];
  try {
    sessions = await server.listSessions();
  } catch (e) {
    log.warn("listCrushSessions failed", { error: String(e) });
    return [];
  }
  return sessions
    .slice()
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
    .slice(0, limit)
    .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updated_at }));
}
