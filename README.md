# crush-Telegram

Your [Crush](https://github.com/charmbracelet/crush) AI assistant in your pocket. A full-stack bridge between Telegram and the Crush CLI that delivers the **complete terminal experience** — not a limited headless wrapper.

## How it works

The bridge is a real Crush **client** over the server's HTTP+SSE API (`crush server`). This is the same protocol the TUI uses. The workspace binds to your project directory and shares its `~/.crush` database, so **every terminal session is visible, loadable, and continuable from Telegram**.

```
Phone  ←──→  Telegram Bot API  ←──→  Bridge (Bun)  ←──→  crush server
                                      · HTTP REST        · agent + tools
                                      · SSE events        · skills
                                      · auto-restart      · shared ~/.crush
```

## Features

- **Session continuity** — multi-turn conversations with full recall, just like the terminal
- **Load any old session** — `/sessions` shows clickable buttons with titles + message counts. Tap to load and continue. Works with terminal-created sessions
- **Tools and skills** — file reads, writes, bash, LSP, MCP — all execute through the server. Tool calls surface live as `🔧 tool` messages
- **Interactive permission flow** — Allow/Deny/Allow-session buttons per tool call (set `CRUSH_AUTO_ALLOW=false`)
- **Live streaming** — assistant text streams into the reply as it generates
- **Server auto-recovery** — bridge detects server death, restarts it, reconnects, resumes
- **Web dashboard** — live state at `http://localhost:PORT/?key=...`

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/new` | Start a fresh session |
| `/sessions` | List sessions as clickable buttons with titles |
| `/resume <id>` | Load and continue a session (accepts short ID prefix) |
| `/stop` | Cancel the running turn |
| `/status` | Bridge state |
| `/log` | Tail bridge logs |
| *(anything else)* | Runs a Crush turn |

## Setup

```bash
git clone https://github.com/naoufac/crush-Telegram.git
cd crush-Telegram
cp .env.example .env  # fill in TELEGRAM_BOT_TOKEN, OWNER_ID
bun run src/index.ts
```

### `.env` reference

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...   # from @BotFather (required)
OWNER_ID=123456789                      # your user ID (required)
CRUSH_SERVER_PORT=23917                 # crush server TCP port
CRUSH_CWD=/root                         # project dir (shares ~/.crush)
CRUSH_AUTO_ALLOW=true                   # auto-allow tools (matches allowed_tools:["*"])
CRUSH_TIMEOUT=600                       # max turn seconds
DASH_PORT=8088                          # dashboard port (blank=off)
DASH_KEY=your-secret                    # dashboard access key
```

## Architecture

| File | Role |
|------|------|
| `src/server-client.ts` | Crush server lifecycle + HTTP/SSE client (workspace, sessions, agent, permissions) |
| `src/crush.ts` | Turn execution: send prompt, demux SSE events, resolve on run_complete |
| `src/index.ts` | Telegram polling, command dispatch, inline-keyboard permission/question flows, streaming |
| `src/sessions.ts` | Per-chat session persistence, create/load/list/new |
| `src/telegram.ts` | Bot API client (zero deps): chunking, Markdown fallback, inline keyboards, long-poll |
| `src/dashboard.ts` | Optional web dashboard |
| `src/config.ts` | `.env` loader + typed config |
| `src/logger.ts` | Leveled file logger |

## Stress test

```bash
python3 stress-test.py
```

Covers: rapid-fire commands, multi-turn continuity, concurrent queueing, long-output chunking, session switching isolation, tool execution (file write + disk verify), unicode, server restart recovery, session titles.

## Tech

Bun + TypeScript, zero runtime dependencies. Crush server HTTP REST + SSE over TCP localhost. Telegram Bot API via fetch.

## License

MIT
