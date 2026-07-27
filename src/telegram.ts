import type { Config } from "./config.ts";

const API = "https://api.telegram.org/bot";

// Test hook: when set, captures every outgoing message text for verification.
// Null in production (no overhead). Set by the test harness only.
let outgoingCapture: ((chatId: number, text: string) => void) | null = null;
export function setOutgoingCapture(fn: ((chatId: number, text: string) => void) | null) {
  outgoingCapture = fn;
}

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
    // If Markdown parsing fails, retry without parse_mode (plain text).
    if (body?.parse_mode && /can.?t parse entities|entity starting/i.test(json.description ?? "")) {
      const stripped = { ...body };
      delete stripped.parse_mode;
      return tgFetch(cfg, method, stripped);
    }
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
  opts: { replyTo?: number; parseMode?: string; disablePreview?: boolean; replyMarkup?: unknown } = {},
) {
  if (outgoingCapture) outgoingCapture(chatId, text);
  const maxLen = 4096;
  try {
    return await sendChunked(cfg, chatId, text, opts);
  } catch (e) {
    // If reply_to failed (deleted/old message), retry without it
    if (opts.replyTo && /reply.*not found|message to be replied/i.test(String(e))) {
      return await sendChunked(cfg, chatId, text, { ...opts, replyTo: undefined });
    }
    throw e;
  }
}

async function sendChunked(
  cfg: Config,
  chatId: number,
  text: string,
  opts: { replyTo?: number; parseMode?: string; disablePreview?: boolean; replyMarkup?: unknown },
) {
  const maxLen = 4096;
  if (text.length <= maxLen) {
    return tgFetch(cfg, "sendMessage", {
      chat_id: chatId,
      text,
      reply_to_message_id: opts.replyTo,
      parse_mode: opts.parseMode,
      disable_web_page_preview: opts.disablePreview ?? true,
      reply_markup: opts.replyMarkup,
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
      reply_markup: opts.replyMarkup,
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

export async function editMessageText(
  cfg: Config,
  chatId: number,
  messageId: number,
  text: string,
  opts: { parseMode?: string; replyMarkup?: unknown } = {},
) {
  if (outgoingCapture) outgoingCapture(chatId, text);
  try {
    return await tgFetch(cfg, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: opts.parseMode,
      reply_markup: opts.replyMarkup,
    });
  } catch {
    // edit fails if text unchanged or message too old; best effort
  }
}

export interface InlineButton {
  text: string;
  callbackData: string;
}

export function inlineKeyboard(rows: InlineButton[][]) {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((b) => ({ text: b.text, callback_data: b.callbackData })),
    ),
  };
}

export async function answerCallback(cfg: Config, callbackId: string, text?: string, showAlert = false) {
  try {
    await tgFetch(cfg, "answerCallbackQuery", { callback_query_id: callbackId, text, show_alert: showAlert });
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
