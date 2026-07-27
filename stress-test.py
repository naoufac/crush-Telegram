#!/usr/bin/env python3
"""
Stress test for the crush-Telegram bridge via real Telegram (MTProto).
Sends messages AS the owner, reads replies, validates every feature.
"""
import subprocess, json, time, sys, os

BOT = "CrushNaoBot"
BOT_ID = 8673568823
PASS = 0; FAIL = 0; RESULTS = []

def tg_send(msg):
    r = subprocess.run(["tg", "send", BOT, msg], capture_output=True, text=True, timeout=15)
    if r.returncode != 0: return None
    try: return json.loads(r.stdout.strip().split("\n")[-1]).get("sent")
    except: return None

def tg_history(limit=10, min_id=0):
    cmd = ["tg", "history", BOT, "--json", "--limit", str(limit)]
    if min_id: cmd += ["--min-id", str(min_id)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    msgs = []
    for line in r.stdout.strip().split("\n"):
        line = line.strip()
        if not line: continue
        try: msgs.append(json.loads(line))
        except: pass
    return msgs

def last_id():
    msgs = tg_history(limit=1)
    return msgs[0]["id"] if msgs else 0

def bot_replies_since(msg_id):
    msgs = tg_history(limit=30, min_id=msg_id)
    return [m for m in msgs if m.get("sender_id") == BOT_ID]

def send_and_collect(text, wait=60):
    before = last_id()
    sent = tg_send(text)
    if sent is None: return [], "send failed"
    baseline = max(sent, before)
    deadline = time.time() + wait
    prev_count = 0; stable = 0
    while time.time() < deadline:
        time.sleep(3)
        new = bot_replies_since(baseline)
        if len(new) > prev_count: prev_count = len(new); stable = 0
        else: stable += 1
        if new and stable >= 2: break
    return [m.get("text", "") for m in bot_replies_since(baseline)], None

def check(name, cond, detail=""):
    global PASS, FAIL
    if cond: PASS += 1
    else: FAIL += 1
    icon = "✅" if cond else "❌"
    print(f"  [{icon}] {name}" + (f"  — {detail}" if detail else ""))
    RESULTS.append(("PASS" if cond else "FAIL", name, detail))

print("=" * 60)
print(f"STRESS TEST — started {time.strftime('%H:%M:%S')}")
print("=" * 60)

# ── 1: Rapid-fire slash commands ──
print("\n[1] Rapid-fire slash commands")
before = last_id()
for cmd in ["/help", "/status", "/sessions", "/log", "/new"]:
    tg_send(cmd); time.sleep(0.3)
time.sleep(25)
reps = [m.get("text","") for m in bot_replies_since(before)]
C = "\n".join(reps)
check("help", any("Commands" in r for r in reps))
check("status", any("workspace" in r.lower() or "Bridge status" in r for r in reps))
check("sessions", any("session" in r.lower() for r in reps))
check("log", any("INFO" in r or "WARN" in r for r in reps))
check("new", any("new" in r.lower() or "✨" in r for r in reps))
check("all 5 answered", len(reps) >= 5, f"got {len(reps)}")

# ── 2: Multi-turn continuity ──
print("\n[2] Multi-turn continuity")
r,_ = send_and_collect("Remember: my name is TESTER, fav number 7741, code word DELTA. Reply only: GOT IT", 50)
check("plants facts", any("GOT IT" in t.upper() for t in r), f"sample={[t[:40] for t in r]}")
r,_ = send_and_collect("What is my name? Reply only the name.", 50)
check("recalls name", any("TESTER" in t for t in r), f"texts={[t[:40] for t in r]}")
r,_ = send_and_collect("What is my favorite number? Reply only the number.", 50)
check("recalls number", any("7741" in t for t in r), f"texts={[t[:40] for t in r]}")
r,_ = send_and_collect("What is my code word? Reply only the word.", 50)
check("recalls code word", any("DELTA" in t for t in r), f"texts={[t[:40] for t in r]}")

# ── 3: Concurrent message ──
print("\n[3] Concurrent message queueing")
before = last_id()
tg_send("Write a haiku about the ocean.")
time.sleep(3)
tg_send("What is 2+2? Reply only the number.")
time.sleep(40)
reps = [m.get("text","") for m in bot_replies_since(before)]
C = "\n".join(reps).lower()
check("haiku reply", any("ocean" in t.lower() or "sea" in t.lower() or "wave" in t.lower() for t in reps), f"{len(reps)} replies")
check("math reply", any("4" in t for t in reps), f"texts={[t[:40] for t in reps]}")

# ── 4: Long output ──
print("\n[4] Long output chunking")
r,_ = send_and_collect("Generate a numbered list from 1 to 30. For each, one sentence about an animal.", 90)
C = "\n".join(r)
check("long output", len(C) > 800, f"chars={len(C)}")
check("many items", "20" in C or "25" in C or "30" in C)

# ── 5: Session switching ──
print("\n[5] Session switching isolation")
r,_ = send_and_collect("/new", 10)
check("/new works", any("new" in t.lower() or "✨" in t for t in r))
r,_ = send_and_collect("My secret is SESSION5-KEY. Reply only: STORED", 50)
check("fact planted", any("STORED" in t.upper() for t in r))
r,_ = send_and_collect("What is my secret? Reply only the secret.", 50)
check("fact recalled", any("SESSION5-KEY" in t for t in r), f"texts={[t[:40] for t in r]}")
r,_ = send_and_collect("/new", 10)
r,_ = send_and_collect("What is my secret? If unknown say NOSECRET.", 50)
check("old fact gone", any("NOSECRET" in t.upper() for t in r) and not any("SESSION5" in t for t in r), f"texts={[t[:40] for t in r]}")

# ── 6: Tool execution ──
print("\n[6] Tool execution")
os.system("rm -f /tmp/stress-test-marker.txt")
r,_ = send_and_collect("Create /tmp/stress-test-marker.txt with content STRESSMARKER999. Read it back and tell me contents.", 70)
C = "\n".join(r)
check("tool mentions marker", "STRESSMARKER999" in C, f"texts={[t[:60] for t in r]}")
check("file exists", os.path.exists("/tmp/stress-test-marker.txt"))
if os.path.exists("/tmp/stress-test-marker.txt"):
    check("file content correct", "STRESSMARKER999" in open("/tmp/stress-test-marker.txt").read())
else:
    check("file content correct", False)

# ── 7: Edge cases ──
print("\n[7] Edge cases")
r,_ = send_and_collect("Reply with exactly: héllo wörld éàç", 50)
check("unicode handled", len(r) > 0, f"replies={len(r)} texts={[t[:40] for t in r]}")
before = last_id()
tg_send("x"); time.sleep(10)
reps = [m.get("text","") for m in bot_replies_since(before)]
check("single-char handled", len(reps) > 0, f"replies={len(reps)}")

# ── 8: /sessions titles + buttons ──
print("\n[8] /sessions with titles")
before = last_id()
tg_send("/sessions"); time.sleep(8)
reps = [m.get("text","") for m in bot_replies_since(before)]
check("sessions has titles", any(len(t) > 30 for t in reps), f"texts={[t[:60] for t in reps]}")

# ── 9: Server restart recovery (LAST — may disrupt) ──
print("\n[9] Server restart recovery (LAST)")
pids = subprocess.run(["pgrep", "-f", "crush server -H tcp"], capture_output=True, text=True).stdout.strip().split("\n")
for p in pids:
    if p.strip(): subprocess.run(["kill", p.strip()])
print("  killed server, waiting for auto-restart...")
ok = False
for i in range(45):
    try:
        import urllib.request
        if urllib.request.urlopen("http://127.0.0.1:23917/v1/health", timeout=2).status == 200:
            ok = True; break
    except: pass
    time.sleep(2)
check("server auto-restarted", ok, f"after {(i+1)*2}s" if ok else "timeout")
if ok:
    time.sleep(8)
    r,_ = send_and_collect("Reply with exactly: RECOVERED-OK", 70)
    check("turn after recovery", any("RECOVERED-OK" in t for t in r), f"texts={[t[:40] for t in r]}")

# ── SUMMARY ──
print("\n" + "═" * 60)
print(f"RESULTS: {PASS} PASS, {FAIL} FAIL out of {PASS + FAIL}")
print("═" * 60)
if FAIL > 0:
    print("\nFAILURES:")
    for s,n,d in RESULTS:
        if s=="FAIL": print(f"  ❌ {n}" + (f" — {d}" if d else ""))
sys.exit(1 if FAIL > 0 else 0)
