import type { Config } from "./config.ts";

const API = "https://api.telegram.org/bot";

export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string; first_name?: string; last_name?: string; username?: string };
  from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
  text?: string;
  caption?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: {
    id: string;
    from: { id: number };
    message?: TgMessage;
    data?: string;
  };
}

async function tgFetch(cfg: Config, method: string, body?: Record<string, unknown>) {
  const url = `${API}${cfg.botToken}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json() as { ok: boolean; description?: string; result?: unknown };
  if (!json.ok) {
    throw new Error(`telegram ${method} failed: ${json.description ?? res.statusText}`);
  }
  return json.result;
}

export async function getMe(cfg: Config) {
  return tgFetch(cfg, "getMe") as Promise<{
    id: number; is_bot: boolean; first_name: string; username: string;
  }>;
}

export async function sendMessage(
  cfg: Config,
  chatId: number,
  text: string,
  opts: { replyTo?: number; parseMode?: string; disablePreview?: boolean } = {},
) {
  const maxLen = 4096;
  if (text.length <= maxLen) {
    return tgFetch(cfg, "sendMessage", {
      chat_id: chatId,
      text,
      reply_to_message_id: opts.replyTo,
      parse_mode: opts.parseMode,
      disable_web_page_preview: opts.disablePreview ?? true,
    });
  }
  // chunk long text on newlines, never exceeding maxLen
  const out: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if ((buf + "\n" + line).length > maxLen) {
      if (buf) out.push(buf);
      buf = line.length > maxLen ? line.slice(0, maxLen) : line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  let last: unknown;
  for (const chunk of out) {
    last = await tgFetch(cfg, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      reply_to_message_id: opts.replyTo,
      parse_mode: opts.parseMode,
      disable_web_page_preview: opts.disablePreview ?? true,
    });
  }
  return last;
}

export async function sendChatAction(cfg: Config, chatId: number, action = "typing") {
  try {
    await tgFetch(cfg, "sendChatAction", { chat_id: chatId, action });
  } catch {
    // best effort
  }
}

export async function answerCallback(cfg: Config, callbackId: string, text?: string) {
  try {
    await tgFetch(cfg, "answerCallbackQuery", { callback_query_id: callbackId, text });
  } catch {
    // best effort
  }
}

export async function getUpdates(cfg: Config, offset: number, timeout = 30): Promise<TgUpdate[]> {
  return tgFetch(cfg, "getUpdates", {
    offset,
    timeout,
    allowed_updates: ["message", "callback_query"],
  }) as Promise<TgUpdate[]>;
}

export async function setMyCommands(cfg: Config, chatId: number) {
  const commands = [
    { command: "new", description: "Start a fresh Crush session" },
    { command: "sessions", description: "List recent Crush sessions" },
    { command: "stop", description: "Kill the running turn" },
    { command: "status", description: "Show bridge status" },
    { command: "log", description: "Tail bridge logs" },
    { command: "reboot", description: "Restart the bridge" },
    { command: "help", description: "Show help" },
  ];
  await tgFetch(cfg, "setMyCommands", { commands, scope: { type: "chat", chat_id: chatId } });
}
