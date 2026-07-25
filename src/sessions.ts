import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { homedir } from "node:os";

const DATA_DIR = resolve(process.cwd(), "data");
const SESSIONS_DIR = resolve(DATA_DIR, "sessions");
if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });

const CRUSH_DIR = resolve(homedir(), ".crush");

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

export function listCrushSessions(limit = 12): Array<{ id: string; mtime: number }> {
  const projectsDir = resolve(CRUSH_DIR, "projects");
  if (!existsSync(projectsDir)) return [];
  const out: Array<{ id: string; mtime: number }> = [];
  try {
    for (const proj of readdirSync(projectsDir)) {
      const projSessions = resolve(projectsDir, proj, "sessions");
      if (!existsSync(projSessions)) continue;
      for (const f of readdirSync(projSessions)) {
        if (!f.endsWith(".json")) continue;
        const full = resolve(projSessions, f);
        try {
          const st = statSync(full);
          out.push({ id: basename(f).replace(/\.json$/, ""), mtime: st.mtimeMs });
        } catch {
          // skip
        }
      }
    }
  } catch {
    // ignore
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

export function recentChatSessions(limit = 12): Array<{ chatId: number } & StoredSession> {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
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
