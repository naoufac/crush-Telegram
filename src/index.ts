import { config as cfg } from "./config.ts";
import { log } from "./logger.ts";
import {
  getMe, getUpdates, sendMessage, sendChatAction, setMyCommands, answerCallback,
  type TgMessage,
} from "./telegram.ts";
import { runTurn, stop, isRunning, activeRuns } from "./crush.ts";
import { getSession, clearSession, recentChatSessions } from "./sessions.ts";
import { startDashboard, makeState } from "./dashboard.ts";

let botUsername = "crush_bot";
let offset = 0;
let bootedAt = Date.now();

const HELP = `*crush-Telegram bridge*

Send any message and it runs a real Crush turn on this host, then streams the reply back. Conversations are continuous — the same session is reused until you /new.

*Commands*
/new — start a fresh Crush session
/stop — kill the running turn
/status — bridge state
/log — tail logs
/sessions — recent chats
/reboot — restart the bridge
/help — this message

anything else — runs a Crush turn (with \`--yolo\` ${cfg.crushYolo ? "ON" : "off"})`;

async function handleOwner(msg: TgMessage) {
  const chatId = msg.chat.id;
  const text = (msg.text ?? msg.caption ?? "").trim();
  if (!text) {
    await sendMessage(cfg, chatId, "Send text and I'll run it as a Crush turn. /help for commands.");
    return;
  }

  // commands
  if (text.startsWith("/")) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd.toLowerCase()) {
      case "start":
      case "help":
        await sendMessage(cfg, chatId, HELP, { parseMode: "Markdown", replyTo: msg.message_id });
        return;
      case "new":
      case "restart":
        clearSession(chatId);
        await sendMessage(cfg, chatId, "✨ New Crush session. Next message starts fresh.", { replyTo: msg.message_id });
        return;
      case "stop":
      case "kill": {
        const killed = await stop(chatId);
        await sendMessage(cfg, chatId, killed ? "🛑 Killed the running turn." : "No active turn to kill.", { replyTo: msg.message_id });
        return;
      }
      case "status": {
        const runs = activeRuns();
        const me = getSession(chatId);
        const lines = [
          `*Bridge status*`,
          `uptime: ${Math.floor((Date.now() - bootedAt) / 1000)}s`,
          `pid: ${process.pid}`,
          `bot: @${botUsername}`,
          `active runs: ${runs.length}`,
          ...(runs.map((r) => `  · chat ${r.chatId}: ${Math.floor(r.elapsedMs / 1000)}s ${r.sessionId ?? ""}`)),
          `your session: ${me.sessionId ?? "(none — /new)"}`,
        ];
        await sendMessage(cfg, chatId, lines.join("\n"), { parseMode: "Markdown", replyTo: msg.message_id });
        return;
      }
      case "log": {
        const { tailLog } = await import("./logger.ts");
        await sendMessage(cfg, chatId, "```\n" + tailLog(40) + "\n```", { parseMode: "Markdown", replyTo: msg.message_id });
        return;
      }
      case "sessions": {
        const chats = recentChatSessions(8);
        if (!chats.length) { await sendMessage(cfg, chatId, "No chat sessions yet."); return; }
        const lines = chats.map((c) =>
          `chat ${c.chatId}: ${c.sessionId ? c.sessionId.slice(0, 8) : "(none)"} — ${(c.firstMessage ?? "").slice(0, 50)}`,
        );
        await sendMessage(cfg, chatId, lines.join("\n"), { replyTo: msg.message_id });
        return;
      }
      case "reboot": {
        await sendMessage(cfg, chatId, "♻️ Rebooting bridge...", { replyTo: msg.message_id });
        log.warn("reboot requested via telegram", { chatId });
        setTimeout(() => process.exit(0), 250);
        return;
      }
      default:
        // unknown slash — pass through to crush so skills like /foo work
        break;
    }
  }

  // run a crush turn
  await sendChatAction(cfg, chatId, "typing");
  // keep typing indicator alive for long turns
  const typer = setInterval(() => sendChatAction(cfg, chatId, "typing"), 4000);

  let lastSent = 0;
  let accumulated = "";
  try {
    const result = await runTurn(chatId, text, {
      resume: true,
      onToken: (chunk) => {
        accumulated += chunk;
        // stream-flush every ~1.5s once we have meaningful new content
        const now = Date.now();
        if (accumulated.length > 0 && now - lastSent > 1500) {
          // we don't flush partials to avoid message spam; full reply is sent at end.
          // (Streaming partial messages would require editing one message repeatedly.)
        }
      },
    });
    clearInterval(typer);

    let body = result.stdout.trim();
    if (!body && result.stderr.trim()) body = `⚠️ ${result.stderr.trim()}`;

    const tag = result.ok ? "" : `⚠️ (exit ${result.exitCode})\n`;
    const sessionTag = result.sessionId ? `\n\n_session ${result.sessionId.slice(0, 8)} · ${Math.floor(result.durationMs / 1000)}s_` : "";
    const final = `${tag}${body}${sessionTag}`.trim();
    await sendMessage(cfg, chatId, final || "(empty reply)", { parseMode: "Markdown", replyTo: msg.message_id });
  } catch (e) {
    clearInterval(typer);
    log.error("turn crashed", { chatId, error: String(e) });
    await sendMessage(cfg, chatId, `❌ Bridge error: ${String(e)}`, { replyTo: msg.message_id });
  }
}

async function loop() {
  log.info("polling telegram", { bot: botUsername, owner: cfg.ownerId });
  while (true) {
    try {
      const updates = await getUpdates(cfg, offset, 30);
      for (const upd of updates) {
        offset = upd.update_id + 1;
        if (upd.callback_query) {
          await answerCallback(cfg, upd.callback_query.id);
          // treat callback data as a message from the owner
          if (upd.callback_query.data && upd.callback_query.message) {
            const fake: TgMessage = {
              ...upd.callback_query.message,
              text: upd.callback_query.data,
              from: { id: upd.callback_query.from.id, is_bot: false },
            };
            if (fake.from?.id === cfg.ownerId) await handleOwner(fake);
          }
          continue;
        }
        const msg = upd.message ?? upd.edited_message;
        if (!msg) continue;
        // strict owner gate
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

async function main() {
  log.info("crush-Telegram bridge booting", {
    owner: cfg.ownerId,
    dash: cfg.dashPort || "off",
    yolo: cfg.crushYolo,
    cwd: cfg.crushCwd,
  });

  const me = await getMe(cfg);
  botUsername = me.username;
  log.info("bot identity", { id: me.id, username: me.username, name: me.first_name });

  await setMyCommands(cfg, cfg.ownerId);
  await sendMessage(cfg, cfg.ownerId,
    `🚀 *crush-Telegram bridge online* as @${botUsername}\n` +
    `Send anything to run a Crush turn. /help for commands.`,
    { parseMode: "Markdown" });

  startDashboard(() => makeState(botUsername));
  await loop();
}

main().catch((e) => {
  log.error("fatal", { error: String(e) });
  process.exit(1);
});
