import { config as cfg } from "./config.ts";
import { log } from "./logger.ts";
import {
  getMe, getUpdates, sendMessage, sendChatAction, setMyCommands, answerCallback,
  editMessageText, inlineKeyboard, type InlineButton, type TgMessage,
} from "./telegram.ts";
import { runTurn, stop, activeRuns, initBridge } from "./crush.ts";
import { server, type PermissionRequest, type QuestionRequest } from "./server-client.ts";
import { getSession, clearSession, recentChatSessions, loadSession, newSession } from "./sessions.ts";
import { startDashboard, makeState } from "./dashboard.ts";

let botUsername = "crush_bot";
let offset = 0;

const HELP = `*crush-Telegram bridge* (live client/server mode)

This bot is a real Crush client over the server API, sharing the terminal's sessions. You can continue any conversation, load old sessions, and approve tool calls right here.

*Commands*
/new — start a fresh session
/sessions — list recent sessions (terminal + here)
/resume <id> — load & continue an existing session
/stop — cancel the running turn
/status — bridge state
/help — this message

Anything else — runs a Crush turn. Tool calls that need approval show Allow/Deny buttons, just like the terminal.`;

// --- pending interactive requests (permissions / questions) ---
interface PendingPerm { chatId: number; perm: PermissionRequest; msgId: number; }
interface PendingQuestion { chatId: number; q: QuestionRequest; }
const pendingPerms = new Map<string, PendingPerm>();
const pendingQuestions = new Map<string, PendingQuestion>();
// chat awaiting a free-text answer to a question
const awaitingText = new Map<number, { batchId: string; questionId: string }>();

function shortKey(): string { return Math.random().toString(36).slice(2, 10); }

// ---------- message handling ----------

export async function handleOwner(msg: TgMessage) {
  const chatId = msg.chat.id;
  const text = (msg.text ?? msg.caption ?? "").trim();

  // If this chat is awaiting a free-text answer to a question, route it there.
  const awaiting = awaitingText.get(chatId);
  if (awaiting && !text.startsWith("/")) {
    awaitingText.delete(chatId);
    try {
      await server.answerQuestion(awaiting.batchId, [{
        request_id: awaiting.questionId,
        fill_in_text: text,
      }]);
      await sendMessage(cfg, chatId, "✓ sent.", { replyTo: msg.message_id });
    } catch (e) {
      await sendMessage(cfg, chatId, `⚠️ ${String(e)}`, { replyTo: msg.message_id });
    }
    return;
  }

  if (!text) {
    await sendMessage(cfg, chatId, "Send text and I'll run it as a Crush turn. /help for commands.");
    return;
  }

  if (text.startsWith("/")) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd.toLowerCase()) {
      case "start":
      case "help":
        await sendMessage(cfg, chatId, HELP, { parseMode: "Markdown", replyTo: msg.message_id });
        return;
      case "new": {
        const sid = await newSession(chatId);
        await sendMessage(cfg, chatId, `✨ New session started.\n\`${sid.slice(0, 8)}\``, { parseMode: "Markdown", replyTo: msg.message_id });
        return;
      }
      case "stop":
      case "kill": {
        const killed = await stop(chatId);
        await sendMessage(cfg, chatId, killed ? "🛑 Turn cancelled." : "No active turn.", { replyTo: msg.message_id });
        return;
      }
      case "sessions": {
        await sendChatAction(cfg, chatId, "typing");
        let sessions;
        try { sessions = await server.listSessions(); }
        catch (e) { await sendMessage(cfg, chatId, `⚠️ ${String(e)}`); return; }
        if (!sessions?.length) { await sendMessage(cfg, chatId, "No sessions yet."); return; }
        sessions.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
        const me = getSession(chatId);
        const top = sessions.slice(0, 12);
        // Build clickable inline keyboard — one button per session.
        // callback_data max 64 bytes: "s:<uuid>" fits easily.
        const rows: InlineButton[][] = top.map((s) => {
          const title = (s.title || "(untitled)").slice(0, 45);
          const cur = s.id === me.sessionId ? " ✅" : "";
          const msgs = s.message_count ? ` (${s.message_count})` : "";
          return [{ text: `${title}${msgs}${cur}`, callbackData: `s:${s.id}` }];
        });
        await sendMessage(cfg, chatId,
          "*Recent sessions* — tap to load:\n(oldest sessions further down)",
          { parseMode: "Markdown", replyTo: msg.message_id, replyMarkup: inlineKeyboard(rows) });
        return;
      }
      case "resume":
      case "load": {
        if (!arg) { await sendMessage(cfg, chatId, "Usage: /resume <session-id> (use /sessions to find one)", { replyTo: msg.message_id }); return; }
        // accept full uuid or a short prefix; resolve prefix against the list
        let id = arg;
        if (arg.length < 32) {
          try {
            const all = await server.listSessions();
            const match = all.find((s) => s.id.startsWith(arg));
            if (!match) { await sendMessage(cfg, chatId, `No session starts with \`${arg}\``, { parseMode: "Markdown" }); return; }
            id = match.id;
          } catch { /* fall through with raw arg */ }
        }
        const ok = await loadSession(chatId, id);
        await sendMessage(cfg, chatId, ok ? `✅ Loaded session \`${id.slice(0, 8)}\`. Next message continues it.` : `⚠️ Session not found.`, { parseMode: "Markdown", replyTo: msg.message_id });
        return;
      }
      case "status": {
        const runs = activeRuns();
        const me = getSession(chatId);
        const lines = [
          `*Bridge status*`,
          `bot: @${botUsername}`,
          `pid: ${process.pid}`,
          `workspace: ${server.workspaceId?.slice(0, 8) ?? "?"}`,
          `active runs: ${runs.length}`,
          ...(runs.map((r) => `  · chat ${r.chatId}: ${Math.floor(r.elapsedMs / 1000)}s ${r.sessionId.slice(0, 8)}`)),
          `your session: ${me.sessionId ? me.sessionId.slice(0, 8) : "(none — /new)"}`,
        ];
        await sendMessage(cfg, chatId, lines.join("\n"), { parseMode: "Markdown", replyTo: msg.message_id });
        return;
      }
      case "log": {
        const { tailLog } = await import("./logger.ts");
        await sendMessage(cfg, chatId, "```\n" + tailLog(40) + "\n```", { parseMode: "Markdown", replyTo: msg.message_id });
        return;
      }
      default:
        break; // unknown slash -> pass through to crush as a prompt
    }
  }

  await runChatTurn(chatId, text, msg.message_id);
}

// ---------- a single chat turn with live streaming + tool prompts ----------

async function runChatTurn(chatId: number, prompt: string, replyTo: number) {
  await sendChatAction(cfg, chatId, "typing");
  const typer = setInterval(() => sendChatAction(cfg, chatId, "typing"), 4000);

  // placeholder that we edit as the assistant streams
  let placeholderId = 0;
  try {
    const ph: any = await sendMessage(cfg, chatId, "…", { replyTo });
    placeholderId = ph?.message_id ?? 0;
  } catch { /* noop */ }

  let lastEdit = 0;
  const sentTools = new Set<string>();
  const editThrottled = (text: string) => {
    const now = Date.now();
    if (placeholderId && now - lastEdit > 1200 && text) {
      lastEdit = now;
      editMessageText(cfg, chatId, placeholderId, text.slice(0, 3900));
    }
  };

  try {
    const result = await runTurn(chatId, prompt, {
      onText: (full) => editThrottled(full),
      onToolCall: (name, input) => {
        const key = name + ":" + input.slice(0, 40);
        if (sentTools.has(key)) return;
        sentTools.add(key);
        const preview = input.replace(/\s+/g, " ").slice(0, 80);
        sendMessage(cfg, chatId, `🔧 ${name}${preview ? ": " + preview : ""}`).catch(() => {});
      },
      onPermission: (perm) => sendPermissionPrompt(chatId, perm),
      onQuestion: (q) => sendQuestionPrompt(chatId, q),
    });

    clearInterval(typer);
    const body = (result.text || "(no text output)").trim();
    const tag = result.cancelled ? "🛑 cancelled" : (result.ok ? "" : "⚠️");
    const sessionTag = `\n\n_session ${result.sessionId.slice(0, 8)} · ${Math.floor(result.durationMs / 1000)}s_`;

    if (body.length > 3900) {
      // too long for an edit: replace placeholder with a marker, send full text
      if (placeholderId) editMessageText(cfg, chatId, placeholderId, `${tag} ✓`.trim());
      await sendMessage(cfg, chatId, `${tag}\n${body}${sessionTag}`.trim(), { parseMode: "Markdown", replyTo });
    } else {
      if (placeholderId) {
        editMessageText(cfg, chatId, placeholderId, `${tag}\n${body}${sessionTag}`.trim(), { parseMode: "Markdown" });
      } else {
        await sendMessage(cfg, chatId, `${tag}\n${body}${sessionTag}`.trim(), { parseMode: "Markdown", replyTo });
      }
    }
  } catch (e) {
    clearInterval(typer);
    log.error("turn crashed", { chatId, error: String(e) });
    if (placeholderId) editMessageText(cfg, chatId, placeholderId, `❌ ${String(e)}`);
    else await sendMessage(cfg, chatId, `❌ ${String(e)}`, { replyTo });
  }
}

// ---------- permission + question prompts ----------

async function sendPermissionPrompt(chatId: number, perm: PermissionRequest) {
  const key = shortKey();
  const desc = perm.description || perm.action || perm.tool_name;
  const lines = [
    `🔐 *Permission requested*`,
    `tool: \`${perm.tool_name}\``,
    desc ? `action: ${desc}` : "",
    perm.path ? `path: \`${perm.path}\`` : "",
  ].filter(Boolean);
  const rows: InlineButton[][] = [[
    { text: "✅ Allow", callbackData: `p:${key}:allow` },
    { text: "❌ Deny", callbackData: `p:${key}:deny` },
    { text: "✅ Allow session", callbackData: `p:${key}:allow_session` },
  ]];
  const sent: any = await sendMessage(cfg, chatId, lines.join("\n"), {
    parseMode: "Markdown",
    replyMarkup: inlineKeyboard(rows),
  });
  pendingPerms.set(key, { chatId, perm, msgId: sent?.message_id ?? 0 });
}

async function sendQuestionPrompt(chatId: number, q: QuestionRequest) {
  const key = shortKey();
  pendingQuestions.set(key, { chatId, q });
  const items = q.questions ?? [];
  for (const item of items) {
    const label = q.confirm_title || item.question || item.label || "Question";
    const desc = q.confirm_description || item.description || "";
    const t = item.type;
    if (t === "yes_no") {
      const sent: any = await sendMessage(cfg, chatId,
        `❓ ${label}${desc ? "\n" + desc : ""}`,
        { replyMarkup: inlineKeyboard([[
          { text: "Yes", callbackData: `q:${key}:${item.id}:yes` },
          { text: "No", callbackData: `q:${key}:${item.id}:no` },
        ]]) });
      void sent;
    } else if ((t === "single_choice" || t === "multi_choice") && item.choices?.length) {
      const rows: InlineButton[][] = item.choices.map((c) => [{ text: c.label, callbackData: `q:${key}:${item.id}:${c.id}` }]);
      const sent: any = await sendMessage(cfg, chatId, `❓ ${label}${desc ? "\n" + desc : ""}`, { replyMarkup: inlineKeyboard(rows) });
      void sent;
    } else {
      // free_text (or unknown): ask the user to type the answer
      awaitingText.set(chatId, { batchId: q.id, questionId: item.id });
      await sendMessage(cfg, chatId, `❓ ${label}${desc ? "\n" + desc : ""}\n_Reply with your answer (plain text)._`, { parseMode: "Markdown" });
    }
  }
}

// ---------- callback (button) handling ----------

export async function handleCallback(upd: any) {
  const cb = upd.callback_query;
  await answerCallback(cfg, cb.id);
  const data: string = cb.data ?? "";
  const chatId: number = cb.message?.chat?.id;
  if (!chatId || chatId !== cfg.ownerId) return;
  const msgId = cb.message?.message_id;

  if (data.startsWith("p:")) {
    const [, key, action] = data.split(":");
    const p = pendingPerms.get(key);
    if (!p) { await answerCallback(cfg, cb.id, "expired", true); return; }
    pendingPerms.delete(key);
    try {
      const resolved = await server.grantPermission(p.perm, action as "allow" | "deny" | "allow_session");
      const label = action === "allow" ? "✅ Allowed" : action === "allow_session" ? "✅ Allowed for session" : "❌ Denied";
      if (msgId) editMessageText(cfg, chatId, msgId, `${label}${resolved ? "" : " (already resolved)"}`);
    } catch (e) {
      if (msgId) editMessageText(cfg, chatId, msgId, `⚠️ ${String(e)}`);
    }
    return;
  }

  if (data.startsWith("s:")) {
    const sessionId = data.slice(2);
    try {
      // Verify the session exists, then bind this chat to it
      const sess = await server.getSession(sessionId);
      const ok = await loadSession(chatId, sessionId);
      const title = sess.title?.slice(0, 50) || "(untitled)";
      const label = ok ? `✅ Loaded: ${title}` : `⚠️ Failed to load session`;
      await answerCallback(cfg, cb.id, ok ? `Loaded: ${title}` : "Failed");
      if (msgId) editMessageText(cfg, chatId, msgId, `${label}\nSend a message to continue this session.`);
    } catch (e) {
      await answerCallback(cfg, cb.id, "Session not found");
      if (msgId) editMessageText(cfg, chatId, msgId, `⚠️ ${String(e)}`);
    }
    return;
  }

  if (data.startsWith("q:")) {
    const [, key, questionId, choice] = data.split(":");
    const p = pendingQuestions.get(key);
    if (!p) { await answerCallback(cfg, cb.id, "expired", true); return; }
    const responses = [{
      request_id: questionId,
      ...(p.q.questions[0]?.type === "yes_no"
        ? { yes: choice === "yes" }
        : { selected_ids: [choice] }),
    }];
    try {
      await server.answerQuestion(p.q.id, responses);
      pendingQuestions.delete(key);
      if (msgId) editMessageText(cfg, chatId, msgId, `✓ Answered: ${choice}`);
    } catch (e) {
      if (msgId) editMessageText(cfg, chatId, msgId, `⚠️ ${String(e)}`);
    }
    return;
  }
}

// ---------- main loop ----------

export async function loop() {
  log.info("polling telegram", { bot: botUsername, owner: cfg.ownerId });
  while (true) {
    try {
      const updates = await getUpdates(cfg, offset, 30);
      for (const upd of updates) {
        offset = upd.update_id + 1;
        if (upd.callback_query) { await handleCallback(upd); continue; }
        const msg = upd.message ?? upd.edited_message;
        if (!msg) continue;
        if (msg.from?.id !== cfg.ownerId) {
          log.warn("ignored non-owner message", { from: msg.from?.id, chat: msg.chat.id });
          continue;
        }
        await handleOwner(msg);
      }
    } catch (e) {
      log.error("poll loop error", { error: String(e) });
      await Bun.sleep(2000);
    }
  }
}

export async function startPolling() {
  log.info("crush-Telegram bridge booting (client/server mode)", {
    owner: cfg.ownerId, dash: cfg.dashPort || "off", cwd: cfg.crushCwd, serverPort: cfg.crushServerPort,
  });

  await initBridge();

  const me = await getMe(cfg);
  botUsername = me.username;
  log.info("bot identity", { id: me.id, username: me.username, name: me.first_name });

  try { await setMyCommands(cfg, cfg.ownerId); } catch (e) { log.warn("setMyCommands skipped", { error: String(e) }); }
  try {
    await sendMessage(cfg, cfg.ownerId,
      `🚀 *crush-Telegram bridge online* as @${botUsername}\n` +
      `Live client/server mode — sessions are shared with your terminal. /help for commands.`,
      { parseMode: "Markdown" });
  } catch (e) { log.warn("welcome message skipped", { error: String(e) }); }

  startDashboard(() => makeState(botUsername));
  await loop();
}

startPolling().catch((e) => {
  log.error("fatal", { error: String(e) });
  process.exit(1);
});
