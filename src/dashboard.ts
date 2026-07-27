import { config as cfg } from "./config.ts";
import { log, tailLog } from "./logger.ts";
import { activeRuns } from "./crush.ts";
import { recentChatSessions, listCrushSessions } from "./sessions.ts";

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>crush-Telegram bridge</title>
<style>
  :root {
    --bg:#0d1117; --panel:#161b22; --border:#30363d; --text:#e6edf3;
    --muted:#8b949e; --accent:#58a6ff; --green:#3fb950; --amber:#d29922; --red:#f85149;
  }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
         background:var(--bg); color:var(--text); line-height:1.5; }
  header { padding:1.5rem 2rem; border-bottom:1px solid var(--border); }
  header h1 { margin:0; font-size:1.25rem; font-weight:600; }
  header h1 span { color:var(--accent); }
  header .sub { color:var(--muted); font-size:.85rem; margin-top:.25rem; }
  main { max-width:1100px; margin:0 auto; padding:2rem; display:grid; gap:1.5rem; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
  @media (max-width:700px){ .grid2{ grid-template-columns:1fr; } }
  .panel { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:1.25rem; }
  .panel h2 { margin:0 0 .75rem; font-size:.9rem; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
  .stat { display:flex; justify-content:space-between; padding:.35rem 0; border-bottom:1px solid var(--border); font-size:.9rem; }
  .stat:last-child { border-bottom:0; }
  .stat .k { color:var(--muted); }
  .badge { display:inline-block; padding:.15rem .5rem; border-radius:12px; font-size:.75rem; font-weight:600; }
  .badge.green { background:rgba(63,185,80,.15); color:var(--green); }
  .badge.amber { background:rgba(210,153,34,.15); color:var(--amber); }
  .badge.red { background:rgba(248,81,73,.15); color:var(--red); }
  pre { background:#010409; border:1px solid var(--border); border-radius:6px; padding:.75rem;
        overflow:auto; font-size:.78rem; line-height:1.4; max-height:340px; margin:0; }
  .row { padding:.5rem 0; border-bottom:1px solid var(--border); font-size:.85rem; }
  .row:last-child { border-bottom:0; }
  .row .muted { color:var(--muted); }
  a { color:var(--accent); }
  footer { text-align:center; padding:1rem; color:var(--muted); font-size:.8rem; }
</style>
</head>
<body>
<header>
  <h1>crush<span>·</span>Telegram bridge</h1>
  <div class="sub" id="sub">loading...</div>
</header>
<main>
  <div class="grid2">
    <div class="panel">
      <h2>Status</h2>
      <div id="status"><span class="muted">fetching...</span></div>
    </div>
    <div class="panel">
      <h2>Active runs</h2>
      <div id="runs"><span class="muted">none</span></div>
    </div>
  </div>
  <div class="grid2">
    <div class="panel">
      <h2>Chat sessions</h2>
      <div id="chats"><span class="muted">none</span></div>
    </div>
    <div class="panel">
      <h2>Recent Crush sessions</h2>
      <div id="crush-sessions"><span class="muted">none</span></div>
    </div>
  </div>
  <div class="panel">
    <h2>Log tail <button id="refresh" style="float:right;background:var(--border);color:var(--text);border:0;padding:.2rem .6rem;border-radius:4px;cursor:pointer">refresh</button></h2>
    <pre id="log">...</pre>
  </div>
</main>
<footer>crush-Telegram bridge · <a href="https://github.com/naoufac/crush-Telegram">github.com/naoufac/crush-Telegram</a></footer>
<script>
const KEY = new URLSearchParams(location.search).get('key') || '';
async function go(){
  try {
    const r = await fetch('/api/state?key=' + encodeURIComponent(KEY));
    if (!r.ok) throw new Error(r.status);
    const s = await r.json();
    const fmtMs = ms => {
      if (ms < 1000) return ms + 'ms';
      if (ms < 60000) return (ms/1000).toFixed(1) + 's';
      return Math.floor(ms/60000) + 'm ' + Math.floor((ms%60000)/1000) + 's';
    };
    const ago = t => t ? new Date(t).toLocaleTimeString() : '-';
    document.getElementById('sub').textContent = 'up ' + fmtMs(s.uptimeMs) + ' · pid ' + s.pid + ' · ' + new Date().toLocaleTimeString();
    let st = '';
    st += row('Bot', '@' + (s.botUsername || '?'));
    st += row('Owner id', s.ownerId);
    st += row('Bridge uptime', fmtMs(s.uptimeMs));
    st += row('Crush cwd', s.crushCwd);
    st += row('Yolo', s.yolo ? '<span class="badge amber">on</span>' : '<span class="badge green">off</span>');
    st += row('Dashboard', s.dash ? '<span class="badge green">on :' + s.dashPort + '</span>' : '<span class="muted">off</span>');
    document.getElementById('status').innerHTML = st;
    document.getElementById('runs').innerHTML = s.activeRuns.length
      ? s.activeRuns.map(r => '<div class="row"><span class="badge amber">running</span> chat ' + r.chatId + ' · ' + fmtMs(r.elapsedMs) + ' · ' + (r.sessionId||'new') + '</div>').join('')
      : '<span class="muted">none</span>';
    document.getElementById('chats').innerHTML = s.chatSessions.length
      ? s.chatSessions.map(c => '<div class="row">chat ' + c.chatId + ' <span class="muted">' + (c.sessionId ? c.sessionId.slice(0,8) : 'no session') + '</span> · ' + escapeHtml((c.firstMessage||'').slice(0,60)) + '</div>').join('')
      : '<span class="muted">none</span>';
    document.getElementById('crush-sessions').innerHTML = s.crushSessions.length
      ? s.crushSessions.map(x => '<div class="row">' + x.id.slice(0,8) + ' <span class="muted">' + new Date(x.mtime).toLocaleString() + '</span></div>').join('')
      : '<span class="muted">none</span>';
    document.getElementById('log').textContent = s.logTail;
  } catch(e) {
    document.getElementById('sub').textContent = 'error: ' + e.message;
  }
}
function row(k,v){ return '<div class="stat"><span class="k">'+k+'</span><span>'+v+'</span></div>'; }
function escapeHtml(s){ return (s||'').replace(/[&<>"]/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
document.getElementById('refresh').onclick = go;
go();
setInterval(go, 4000);
</script>
</body>
</html>`;

export interface BridgeState {
  pid: number;
  uptimeMs: number;
  ownerId: number;
  botUsername: string;
  crushCwd: string;
  yolo: boolean;
  dash: boolean;
  dashPort: number;
  activeRuns: ReturnType<typeof activeRuns>;
  chatSessions: Awaited<ReturnType<typeof recentChatSessions>>;
  crushSessions: Awaited<ReturnType<typeof listCrushSessions>>;
  logTail: string;
}

const STARTED_AT = Date.now();

export async function makeState(botUsername: string): Promise<BridgeState> {
  return {
    pid: process.pid,
    uptimeMs: Date.now() - STARTED_AT,
    ownerId: cfg.ownerId,
    botUsername,
    crushCwd: cfg.crushCwd,
    yolo: cfg.crushYolo,
    dash: cfg.dashPort > 0,
    dashPort: cfg.dashPort,
    activeRuns: activeRuns(),
    chatSessions: await recentChatSessions(),
    crushSessions: await listCrushSessions(),
    logTail: tailLog(80),
  };
}

export function startDashboard(getState: () => Promise<BridgeState>) {
  if (cfg.dashPort <= 0) return;
  const server = Bun.serve({
    port: cfg.dashPort,
    fetch: async (req) => {
      const url = new URL(req.url);
      const key = url.searchParams.get("key") ?? "";
      const dashKeyOk = !cfg.dashKey || cfg.dashKey === "" || key === cfg.dashKey;
      if (url.pathname === "/api/state") {
        if (!dashKeyOk) return new Response("forbidden", { status: 403 });
        return Response.json(await getState());
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        if (!dashKeyOk) return new Response("forbidden — pass ?key=...", { status: 403 });
        return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  log.info("dashboard listening", { port: cfg.dashPort, url: `http://localhost:${cfg.dashPort}/?key=${cfg.dashKey}` });
  return server;
}
