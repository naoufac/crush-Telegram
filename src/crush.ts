import { spawn, type Subprocess } from "bun";
import { config as cfg } from "./config.ts";
import { log } from "./logger.ts";
import { getSession, setSession } from "./sessions.ts";

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  sessionId: string | null;
  durationMs: number;
}

const active = new Map<number, { proc: Subprocess; startedAt: number; sessionId: string | null }>();

export function isRunning(chatId: number): boolean {
  return active.has(chatId);
}

export async function stop(chatId: number): Promise<boolean> {
  const entry = active.get(chatId);
  if (!entry) return false;
  try {
    entry.proc.kill();
  } catch {
    // already dead
  }
  active.delete(chatId);
  log.warn("turn killed", { chatId, sessionId: entry.sessionId });
  return true;
}

function parseSessionId(out: string): string | null {
  // crush run prints session info; the session id appears as a UUID-like token.
  // We try a few shapes: "session: <id>", "Session id: <id>", a bare 8-4-4-4-12 uuid.
  const patterns = [
    /session[:\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
  ];
  for (const re of patterns) {
    const m = out.match(re);
    if (m) return m[1];
  }
  return null;
}

export async function runTurn(
  chatId: number,
  prompt: string,
  opts: { resume?: boolean; onToken?: (chunk: string) => void } = {},
): Promise<RunResult> {
  if (active.has(chatId)) {
    return {
      ok: false,
      stdout: "",
      stderr: "A turn is already running for this chat. Send /stop to kill it first.",
      exitCode: null,
      sessionId: getSession(chatId).sessionId,
      durationMs: 0,
    };
  }

  const stored = getSession(chatId);
  const args = ["run"];
  if (opts.resume && stored.sessionId) args.push("--session", stored.sessionId);
  if (cfg.crushModel) args.push("--model", cfg.crushModel);
  args.push(prompt);

  log.info("crush turn starting", { chatId, resume: opts.resume, sessionId: stored.sessionId, promptLen: prompt.length });

  const startedAt = Date.now();
  const proc = Bun.spawn(["crush", ...args], {
    cwd: cfg.crushCwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...(cfg.crushYolo ? {} : {}),
      TG_CHAT_ID: String(chatId),
      TG_BOT_TOKEN: cfg.botToken,
    },
  });

  // Tag as active
  active.set(chatId, { proc, startedAt, sessionId: stored.sessionId });

  // Timeout watchdog
  const watchdog = setTimeout(() => {
    if (active.has(chatId)) {
      log.warn("turn timed out, killing", { chatId, timeout: cfg.crushTimeout });
      try { proc.kill(); } catch { /* noop */ }
    }
  }, cfg.crushTimeout * 1000);

  // Stream stdout
  const stdoutReader = proc.stdout.getReader();
  const stderrReader = proc.stderr.getReader();
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();

  // drain is typed loosely to avoid DOM vs node:stream/web ReadableStreamDefaultReader lib mismatches
  async function drain(stream: any, sink: (s: string) => void) {
    while (true) {
      const { done, value } = await stream.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      sink(chunk);
    }
  }

  try {
    await Promise.all([
      drain(stdoutReader, (c) => {
        stdout += c;
        opts.onToken?.(c);
      }),
      drain(stderrReader, (c) => { stderr += c; }),
    ]);
  } catch (e) {
    stderr += `\n[bridge] stream error: ${String(e)}\n`;
  }

  const exitCode = await proc.exited;
  clearTimeout(watchdog);
  active.delete(chatId);

  const durationMs = Date.now() - startedAt;
  const detectedSession = parseSessionId(stdout + stderr);
  const finalSession = detectedSession ?? stored.sessionId ?? null;

  if (finalSession) {
    const isFirst = !stored.sessionId;
    setSession(chatId, finalSession, isFirst && prompt ? prompt.slice(0, 200) : undefined);
  }

  log.info("crush turn done", { chatId, exitCode, durationMs, sessionId: finalSession });

  return {
    ok: exitCode === 0,
    stdout,
    stderr,
    exitCode,
    sessionId: finalSession,
    durationMs,
  };
}

export function activeRuns() {
  return Array.from(active.entries()).map(([chatId, v]) => ({
    chatId,
    startedAt: v.startedAt,
    sessionId: v.sessionId,
    elapsedMs: Date.now() - v.startedAt,
  }));
}
