# crush-Telegram

**Your Crush AI assistant, in your pocket.** A full-stack bidirectional bridge between a Telegram bot and the [Crush](https://github.com/charmbracelet/crush) CLI — headless turns, session continuity, a web dashboard, and a host-side push tool — all on your own machine, owner-locked, always on.

Send a message from your phone; a real headless Crush turn runs on your server with full tool access and the reply is delivered back. Replies stream into your chat. Past conversations are resumed automatically until you start a fresh one. The host can also push messages *to* you with a one-line CLI.

Built with **Bun + TypeScript, zero runtime dependencies** (stdlib + `Bun.spawn` + `fetch` only).

![architecture](docs/architecture.png)

## Features

- **Real Crush turns** — each message runs `crush run` headless with `--session` continuity, so a conversation on Telegram behaves exactly like one in the terminal.
- **Session continuity** — replies are tagged with the session id and resumed on the next message. `/new` drops the session and starts fresh.
- **Owner-locked** — only your numeric Telegram user id can drive the bot. Everyone else is silently ignored.
- **Web dashboard** — optional light-on-dark status page: live uptime, active runs, per-chat sessions, recent Crush sessions, log tail, system vitals. Token-gated, served by the bridge itself.
- **Push from host** — `bun run src/send.ts "msg"` (or pipe stdin) sends to your chat from cron, hooks, or other scripts. This is the reverse-direction half of the bridge.
- **Self-healing** — broken `--session` targets fall back to a fresh session instead of failing forever.
- **Ops built in** — `/stop` kills a runaway turn, `/status` and `/log` inspect the bridge, `/reboot` restarts it, systemd `Restart=always` keeps it up.

## Architecture

```
   you (phone)  ──►  Telegram Bot API  ──►  bridge (Bun, long polling)
                                                   │
                                  ┌────────────────┼─────────────────┐
                                  ▼                ▼                 ▼
                          Bun.spawn(crush)   sessions.json     web dashboard
                                  │            (per chat)        (:port?key=)
                                  ▼
                          Crush headless turn
                          (full tools, --session)
                                  │
                                  ▼
                          reply streamed back
                          to your Telegram chat

   host scripts  ──►  bun run src/send.ts "msg"  ──►  Telegram Bot API  ──►  you
```

The bridge is a single long-polling loop (`getUpdates`, 30s timeout) that dispatches owner messages to `crush run`. Each chat keeps a `data/sessions/<chatId>.json` recording the active Crush session id, so the next turn resumes it. The dashboard is a separate `Bun.serve` on `DASH_PORT`, gated by `DASH_KEY`. The push tool (`send.ts`) is a standalone script that hits the Telegram API directly.

## Quickstart

Requirements: **Bun 1.1+** and a working `crush` login for the user that runs the bridge.

```bash
# 1. Get a bot token from @BotFather, and your numeric user id from @userinfobot

# 2. Clone and configure
git clone https://github.com/naoufac/crush-Telegram /opt/crush-telegram
cd /opt/crush-telegram
cp .env.example .env && $EDITOR .env       # set TELEGRAM_BOT_TOKEN and OWNER_ID at minimum
chmod 600 .env

# 3. Run in foreground (for testing)
bun run src/index.ts

# 4. Run as a service
sudo cp crush-telegram.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now crush-telegram
journalctl -u crush-telegram -f

# 5. Open your bot in Telegram, press Start, say hi
```

To enable the dashboard, set `DASH_PORT` and `DASH_KEY` in `.env`, open the port in your firewall, and visit `http://your-server:PORT/?key=YOUR_KEY`.

## Configuration (`.env`)

| Var | Required | Description |
|-----|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | yes | Bot token from @BotFather |
| `OWNER_ID` | yes | Your numeric Telegram user id (only this user can drive the bot) |
| `DASH_PORT` | no | Dashboard HTTP port (omit to disable) |
| `DASH_KEY` | no | Dashboard access key (`?key=...`) |
| `CRUSH_CWD` | no | Working directory for headless turns (default `/root`) |
| `CRUSH_YOLO` | no | `true` to run crush with `--yolo` (auto-accept permissions) |
| `CRUSH_TIMEOUT` | no | Max seconds for a turn before it is killed (default `600`) |
| `CRUSH_MODEL` | no | Pin a model, e.g. `gpt-5-codex` |

## Commands

| Command | What it does |
|---|---|
| `/new` | Start a fresh Crush session (drop the resume id) |
| `/stop` | Kill the running turn |
| `/status` | Bridge uptime, active runs, your session |
| `/log` | Tail bridge logs |
| `/sessions` | List recent chat sessions |
| `/reboot` | Restart the bridge process |
| `/help` | Show help |
| anything else | Runs a Crush turn and replies |

Unknown `/slash` commands are passed through to Crush, so skill shortcuts work.

## Push from the host

The bridge is bidirectional. From the host you can push a message to your chat without involving the bot loop:

```bash
# direct
bun run src/send.ts "deploy finished: 12 passed, 0 failed"

# from a pipe
crush run "summarize today's commits" | bun run src/send.ts

# to a specific chat (default is OWNER_ID)
bun run src/send.ts --chat 123456789 "ping"
```

Wire this into cron, deploy hooks, monitoring, or any other script that wants to reach you.

## Security model

- **Owner-locked.** Every inbound message is checked against `OWNER_ID`. Non-owner messages are logged and dropped — no response, no error, nothing. The bot is invisible to everyone else.
- **Token in `.env`.** The bot token and dashboard key live in `.env`, which is gitignored. `chmod 600 .env`.
- **Dashboard gated.** `DASH_KEY` is required for both the HTML page and the `/api/state` endpoint. Without it the dashboard returns 403.
- **No inbound network surface.** The bridge uses long-polling outbound to the Telegram API. The only listener is the optional dashboard port, which you firewall.
- **`--yolo` is opt-in.** Off by default. Enable only on a host where you trust the bot to take actions (file writes, shell commands) without confirmation.
- **Rotate the token if leaked.** If the bot token is exposed (committed, pasted in chat), revoke it via @BotFather and update `.env` immediately.

## Project layout

```
crush-telegram/
├── src/
│   ├── index.ts        # main bot loop: polling, command dispatch, turn runner
│   ├── config.ts       # .env loader + typed config
│   ├── logger.ts       # leveled logger with file sink
│   ├── telegram.ts     # Telegram Bot API client (fetch-based, chunked sends)
│   ├── crush.ts        # Bun.spawn wrapper around `crush run`, session parsing
│   ├── sessions.ts     # per-chat session store + crush session discovery
│   ├── send.ts         # standalone push tool (host -> Telegram)
│   └── dashboard.ts    # Bun.serve dashboard with embedded HTML
├── crush-telegram.service   # systemd unit
├── .env.example             # config template
├── package.json
├── tsconfig.json
└── README.md
```

## Development

```bash
bun install            # dev deps only (typescript types)
bun run typecheck      # tsc --noEmit
bun run dev            # bun --watch, auto-restart on file change
```

## License

MIT © naoufac
