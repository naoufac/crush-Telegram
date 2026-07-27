import { config as cfg } from "./config.ts";
import { log } from "./logger.ts";
import { server, type PermissionRequest, type QuestionRequest, type RunComplete, type CrushEvent } from "./server-client.ts";
import { getSession, setSession, ensureSessionId } from "./sessions.ts";

export interface RunResult {
  ok: boolean;
  text: string;
  sessionId: string;
  durationMs: number;
  cancelled: boolean;
}

export interface TurnCallbacks {
  onText?: (fullText: string) => void;
  onToolCall?: (name: string, inputPreview: string) => void;
  onToolResult?: (name: string, ok: boolean, preview: string) => void;
  onPermission?: (perm: PermissionRequest) => void;
  onQuestion?: (q: QuestionRequest) => void;
}

interface TurnCtx {
  chatId: number;
  sessionId: string;
  runId: string;
  startedAt: number;
  text: string;
  cb: TurnCallbacks;
  resolve: (r: RunResult) => void;
  done: boolean;
}

// sessionId -> active turn (SSE events are routed here)
const activeTurns = new Map<string, TurnCtx>();

export function isRunning(chatId: number): boolean {
  const sid = getSession(chatId).sessionId;
  return !!sid && activeTurns.has(sid);
}

export function activeRuns() {
  return Array.from(activeTurns.values()).map((t) => ({
    chatId: t.chatId,
    sessionId: t.sessionId,
    startedAt: t.startedAt,
    elapsedMs: Date.now() - t.startedAt,
  }));
}

// Locate the active turn for a chat (for stop / cancel).
function ctxForChat(chatId: number): TurnCtx | undefined {
  const sid = getSession(chatId).sessionId;
  return sid ? activeTurns.get(sid) : undefined;
}

export async function stop(chatId: number): Promise<boolean> {
  const ctx = ctxForChat(chatId);
  if (!ctx) return false;
  try { await server.cancelSession(ctx.sessionId); } catch { /* noop */ }
  return true;
}

// --- bridge bootstrap ---

export async function initBridge() {
  await server.ensureServer();
  await server.ensureWorkspace();
  await server.initAgent();
  if (cfg.crushAutoAllow) {
    try { await server.setPermissionsSkip(true); } catch { /* noop */ }
  }
  server.setHandler(handleEvent);
  await server.subscribe();
}

// --- event routing (single SSE stream, demux by session_id) ---

function handleEvent(ev: CrushEvent) {
  const ctx = ev.sessionId ? activeTurns.get(ev.sessionId) : undefined;
  try {
    switch (ev.type) {
      case "message": {
        if (!ctx) break;
        const parts: any[] = ev.data?.parts ?? [];
        for (const p of parts) {
          if (p.type === "text" && typeof p.data?.text === "string") {
            ctx.text = p.data.text;
            ctx.cb.onText?.(ctx.text);
          } else if (p.type === "tool_call") {
            const name = p.data?.name ?? "tool";
            const input = p.data?.input ?? "";
            ctx.cb.onToolCall?.(name, String(input).slice(0, 200));
          } else if (p.type === "tool_result") {
            const name = p.data?.name ?? "tool";
            const ok = !p.data?.is_error;
            ctx.cb.onToolResult?.(name, ok, String(p.data?.content ?? "").slice(0, 200));
          }
        }
        break;
      }
      case "permission_request": {
        const perm = ev.data as PermissionRequest;
        if (perm?.id) {
          if (cfg.crushAutoAllow) {
            server.grantPermission(perm, "allow").catch((e) => log.warn("auto-allow failed", { error: String(e) }));
          } else if (ctx) {
            ctx.cb.onPermission?.(perm);
          }
        }
        break;
      }
      case "question_request": {
        const q = ev.data as QuestionRequest;
        if (q?.id && ctx) ctx.cb.onQuestion?.(q);
        break;
      }
      case "run_complete": {
        const rc = ev.data as RunComplete;
        if (!ctx || ctx.done) break;
        // Only resolve this turn's own terminal event (matched by run_id when set).
        if (rc.run_id && ctx.runId && rc.run_id !== ctx.runId) break;
        ctx.done = true;
        const text = rc.text || ctx.text || (rc.error ? "" : ctx.text);
        const ok = !rc.error && !rc.cancelled;
        activeTurns.delete(ctx.sessionId);
        ctx.resolve({ ok, text, sessionId: ctx.sessionId, durationMs: Date.now() - ctx.startedAt, cancelled: !!rc.cancelled });
        break;
      }
      default:
        break;
    }
  } catch (e) {
    log.error("event handler error", { type: ev.type, error: String(e) });
  }
}

// --- run a turn ---

export async function runTurn(chatId: number, prompt: string, cb: TurnCallbacks = {}): Promise<RunResult> {
  const sessionId = await ensureSessionId(chatId);
  if (activeTurns.has(sessionId)) {
    return {
      ok: false,
      text: "",
      sessionId,
      durationMs: 0,
      cancelled: false,
    };
  }
  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  log.info("turn starting", { chatId, sessionId, runId, promptLen: prompt.length });

  const ctx: TurnCtx = { chatId, sessionId, runId, startedAt, text: "", cb, resolve: () => {}, done: false };
  activeTurns.set(sessionId, ctx);

  const done = new Promise<RunResult>((resolve) => { ctx.resolve = resolve; });
  // watchdog
  const watchdog = setTimeout(() => {
    if (!ctx.done) {
      log.warn("turn timed out", { chatId, sessionId });
      try { server.cancelSession(sessionId); } catch { /* noop */ }
    }
  }, cfg.crushTimeout * 1000);

  try {
    await server.sendMessage(sessionId, prompt, runId);
  } catch (e) {
    activeTurns.delete(sessionId);
    clearTimeout(watchdog);
    return { ok: false, text: `Failed to send: ${String(e)}`, sessionId, durationMs: Date.now() - startedAt, cancelled: false };
  }

  const result = await done;
  clearTimeout(watchdog);
  if (result.text) setSession(chatId, sessionId, undefined);
  log.info("turn done", { chatId, sessionId, ok: result.ok, durationMs: result.durationMs, textLen: result.text.length });
  return result;
}
