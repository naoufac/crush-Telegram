import { spawn, type Subprocess } from "bun";
import { log } from "./logger.ts";
import { config as cfg } from "./config.ts";

// CrushServerClient talks to a long-lived `crush server` over localhost HTTP.
// This is crush's real client/server architecture: the same one the TUI uses.
// A workspace bound to path=/root shares the terminal's /root/.crush, so every
// terminal session is visible and resumable from Telegram. Events (assistant
// text, tool calls, permission requests, questions, run-complete) arrive over a
// single SSE subscription and are demuxed by session_id by the caller.

const BASE = `http://127.0.0.1:${cfg.crushServerPort}`;

export interface SessionMeta {
  id: string;
  title: string;
  message_count: number;
  created_at: number;
  updated_at: number;
  is_busy?: boolean;
}

export interface PermissionRequest {
  id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  description: string;
  action: string;
  params: unknown;
  path: string;
}

export interface QuestionItem {
  id: string;
  type: string;
  label?: string;
  question: string;
  description?: string;
  choices?: { id: string; label: string; description?: string }[];
}

export interface QuestionRequest {
  id: string;
  session_id: string;
  tool_call_id: string;
  questions: QuestionItem[];
  confirm_title?: string;
  confirm_description?: string;
}

export interface RunComplete {
  session_id: string;
  run_id?: string;
  message_id: string;
  text?: string;
  error?: string;
  cancelled?: boolean;
}

// A decoded SSE event. `type` is the pubsub payload type; `data` is the inner
// proto object already unwrapped from the {type:"updated"|"created", payload}
// event envelope where applicable.
export interface CrushEvent {
  type: string;
  sessionId?: string;
  data: any;
  raw: any;
}

type EventHandler = (ev: CrushEvent) => void;

class CrushServerClient {
  private serverProc: Subprocess | null = null;
  workspaceId: string | null = null;
  private clientId = crypto.randomUUID();
  private sseAborted = false;
  private handler: EventHandler | null = null;

  // --- server lifecycle ---

  async ensureServer(): Promise<void> {
    if (await this.healthy()) {
      log.info("crush server already running", { port: cfg.crushServerPort });
      return;
    }
    log.info("starting crush server", { port: cfg.crushServerPort, cwd: cfg.crushCwd });
    this.serverProc = spawn({
      cmd: ["crush", "server", "-H", `tcp://127.0.0.1:${cfg.crushServerPort}`],
      cwd: cfg.crushCwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    // drain logs to bridge log (best effort)
    const outStream: any = this.serverProc!.stdout;
    const errStream: any = this.serverProc!.stderr;
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of outStream) {
        const t = dec.decode(chunk).trim();
        if (t) log.info("[crush-server] " + t.slice(0, 300));
      }
    })().catch(() => {});
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of errStream) {
        const t = dec.decode(chunk).trim();
        if (t) log.warn("[crush-server] " + t.slice(0, 300));
      }
    })().catch(() => {});

    // wait for health
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(500);
      if (await this.healthy()) {
        log.info("crush server healthy", { port: cfg.crushServerPort });
        return;
      }
    }
    throw new Error(`crush server did not become healthy on port ${cfg.crushServerPort}`);
  }

  private async healthy(): Promise<boolean> {
    try {
      const r = await fetch(`${BASE}/v1/health`);
      return r.ok;
    } catch {
      return false;
    }
  }

  async stopServer(): Promise<void> {
    this.sseAborted = true;
    try { this.serverProc?.kill(); } catch { /* noop */ }
    this.serverProc = null;
  }

  // --- http helpers ---

  private async req<T = any>(method: string, path: string, body?: unknown, q?: Record<string, string>): Promise<T> {
    const url = BASE + path + (q ? "?" + new URLSearchParams(q).toString() : "");
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const r = await fetch(url, init);
    const text = await r.text();
    if (!r.ok) {
      let msg = text;
      try { msg = JSON.parse(text)?.message ?? text; } catch { /* keep raw */ }
      throw new Error(`${method} ${path} -> ${r.status}: ${msg.slice(0, 200)}`);
    }
    if (!text) return undefined as T;
    try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
  }

  // --- workspace + sessions ---

  async ensureWorkspace(): Promise<string> {
    // Reuse an existing workspace on this path if present (survives bridge restart
    // against a long-lived server), else create one.
    try {
      const list = await this.req<any[]>("GET", "/v1/workspaces");
      const found = (list ?? []).find((w) => w.path === cfg.crushCwd);
      if (found) {
        this.workspaceId = found.id;
        log.info("reusing workspace", { id: found.id, path: cfg.crushCwd });
        return found.id;
      }
    } catch { /* ignore, try create */ }
    const ws = await this.req<any>("POST", "/v1/workspaces", { path: cfg.crushCwd, client_id: this.clientId });
    this.workspaceId = ws.id;
    log.info("created workspace", { id: ws.id, path: cfg.crushCwd, dataDir: ws.data_dir });
    return ws.id;
  }

  async initAgent(): Promise<void> {
    await this.req("POST", `/v1/workspaces/${this.workspaceId}/agent/init`, { interactive: false });
  }

  async listSessions(): Promise<SessionMeta[]> {
    return this.req<SessionMeta[]>("GET", `/v1/workspaces/${this.workspaceId}/sessions`);
  }

  async createSession(title: string): Promise<SessionMeta> {
    return this.req<SessionMeta>("POST", `/v1/workspaces/${this.workspaceId}/sessions`, { title });
  }

  async getSession(id: string): Promise<SessionMeta> {
    return this.req<SessionMeta>("GET", `/v1/workspaces/${this.workspaceId}/sessions/${id}`);
  }

  async listMessages(sessionId: string): Promise<any[]> {
    return this.req<any[]>("GET", `/v1/workspaces/${this.workspaceId}/sessions/${sessionId}/messages`);
  }

  // --- sending + control ---

  async sendMessage(sessionId: string, prompt: string, runId: string): Promise<void> {
    await this.req("POST", `/v1/workspaces/${this.workspaceId}/agent`, {
      session_id: sessionId,
      run_id: runId,
      prompt,
    });
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.req("POST", `/v1/workspaces/${this.workspaceId}/agent/sessions/${sessionId}/cancel`);
  }

  async grantPermission(perm: PermissionRequest, action: "allow" | "deny" | "allow_session"): Promise<boolean> {
    const r = await this.req<{ resolved: boolean }>("POST", `/v1/workspaces/${this.workspaceId}/permissions/grant`, {
      permission: perm,
      action,
    });
    return r?.resolved ?? false;
  }

  async setPermissionsSkip(skip: boolean): Promise<void> {
    await this.req("POST", `/v1/workspaces/${this.workspaceId}/permissions/skip`, { skip });
  }

  async answerQuestion(batchId: string, responses: any[]): Promise<boolean> {
    const r = await this.req<{ resolved: boolean }>("POST", `/v1/workspaces/${this.workspaceId}/questions/answer`, {
      batch_request_id: batchId,
      responses,
    });
    return r?.resolved ?? false;
  }

  async cancelQuestion(): Promise<boolean> {
    const r = await this.req<{ resolved: boolean }>("POST", `/v1/workspaces/${this.workspaceId}/questions/cancel`);
    return r?.resolved ?? false;
  }

  // --- SSE subscription ---

  setHandler(h: EventHandler) { this.handler = h; }

  async subscribe(): Promise<void> {
    // subscribe must run AFTER ensureWorkspace so client is attached to workspace.
    const url = () => `${BASE}/v1/workspaces/${this.workspaceId}/events?client_id=${encodeURIComponent(this.clientId)}`;
    this.sseAborted = false;
    (async () => {
      while (!this.sseAborted) {
        try {
          // Health gate: if the server died, restart it before reconnecting SSE.
          if (!(await this.healthy())) {
            log.warn("crush server died, restarting", {});
            await this.ensureServer();
            await this.ensureWorkspace();
            await this.initAgent();
            if (cfg.crushAutoAllow) {
              try { await this.setPermissionsSkip(true); } catch { /* noop */ }
            }
          }
          const r = await fetch(url(), { headers: { accept: "text/event-stream", "cache-control": "no-cache" } });
          if (!r.ok || !r.body) throw new Error(`SSE ${r.status}`);
          log.info("SSE stream connected", {});
          const dec = new TextDecoder();
          let buf = "";
          for await (const chunk of r.body) {
            if (this.sseAborted) break;
            buf += dec.decode(chunk, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line.startsWith("data:")) continue;
              this.dispatch(line.slice(5).trim());
            }
          }
        } catch (e) {
          if (this.sseAborted) break;
          log.warn("SSE stream error, reconnecting", { error: String(e) });
        }
        if (this.sseAborted) break;
        await Bun.sleep(1500);
      }
    })().catch((e) => log.error("SSE loop crashed", { error: String(e) }));
    log.info("subscribed to crush events (SSE)", { workspace: this.workspaceId, client: this.clientId });
  }

  private dispatch(jsonStr: string) {
    let env: any;
    try { env = JSON.parse(jsonStr); } catch { return; }
    const type: string = env?.type ?? "";
    const inner = env?.payload?.payload ?? env?.payload ?? env;
    const sessionId =
      inner?.session_id ?? inner?.id ?? inner?.SessionID ??
      (type === "session" ? inner?.id : undefined);
    this.handler?.({ type, sessionId, data: inner, raw: env });
  }
}

export const server = new CrushServerClient();
