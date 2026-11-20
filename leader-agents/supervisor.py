#!/usr/bin/env python3
"""ECA leader agents: the supervisor.

One container, one Hermes workspace per leader, each under its own Linux
account with its own home. This process (root, standard library only):

  * redeems a one-time portal ticket and learns who arrived (/enter);
  * creates that leader's Linux account and Hermes home on first use;
  * starts their Hermes gateway (which serves the Webapp on a loopback port)
    and a small relay that runs AS THE LEADER, so the Webapp sees a local
    connection from its own account, exactly as on a personal machine;
  * tells nginx, per request, which leader a browser belongs to (/_auth);
  * vouches for agent tokens when the ECA backend asks (/internal/verify).

It never sees a model login: each leader signs in to Claude themselves, inside
the unmodified Claude program in their own workspace.

No secret is shared with the backend. Each side trusts the other's HTTPS
address, set in configuration.
"""

from __future__ import annotations

import hashlib
import html
import http.server
import json
import os
import pwd
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

SUP_HOST, SUP_PORT = "127.0.0.1", 9000
DATA = Path(os.environ.get("ECA_DATA_DIR", "/srv/eca"))
HOMES = DATA / "agents"
STATE_FILE = DATA / "state" / "agents.json"
RUN = Path("/run/eca")
BACKEND = os.environ.get("ECA_BACKEND_URL", "https://ecacombined-1.onrender.com").rstrip("/")
PORTAL_ORIGINS = {o.strip().rstrip("/") for o in os.environ.get(
    "ECA_PORTAL_ORIGINS", "https://www.ecastockreport.com,https://ecastockreport.com").split(",") if o.strip()}
IDLE_STOP_MINUTES = int(os.environ.get("ECA_IDLE_STOP_MINUTES", "0") or 0)   # 0 = never
HERMES = "/opt/hermes/bin/hermes"
PLUGIN = "claude-subscription-directsdk"
PROVIDER = "claude-subscription-directsdk-experimental"
DEFAULT_MODEL = os.environ.get("ECA_DEFAULT_MODEL", "sonnet")
AGENT_PATH = "/usr/local/bin:/opt/hermes/bin:/opt/hermes/.venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
COOKIE = "__Host-eca-agent"
SESSION_HOURS = 12
FIRST_UID, FIRST_PORT = 20001, 9201
try:
    WEB_GID = pwd.getpwnam("www-data").pw_gid
except KeyError:          # not on the server image (tests)
    WEB_GID = 33

_lock = threading.RLock()
_state: dict = {"next_uid": FIRST_UID, "next_port": FIRST_PORT, "agents": {}}
_runtime: dict = {}     # slug -> {"status", "detail", "gateway", "relay", "last_seen", "listener_ok_at"}
_sessions: dict = {}    # sha256(cookie) -> {"emp", "expires", "confirmed", "portal"}


def log(msg: str) -> None:
    print(f"[supervisor] {msg}", flush=True)


def _h(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


# ───────────────────────────── state on disk ─────────────────────────────

def load_state() -> None:
    global _state
    try:
        _state = json.loads(STATE_FILE.read_text())
    except FileNotFoundError:
        pass
    except Exception as exc:  # a damaged file must not hand out someone else's home
        log(f"state file unreadable ({exc}); refusing to start")
        raise


def save_state() -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE_FILE.parent, 0o700)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(_state, indent=1))
    os.chmod(tmp, 0o600)
    os.replace(tmp, STATE_FILE)


# ───────────────────────────── linux accounts ─────────────────────────────

def account_name(a: dict) -> str:
    return f"agent_{a['slug']}"


def home_of(a: dict) -> Path:
    return HOMES / a["slug"]


def user_env(a: dict) -> dict:
    home = str(home_of(a))
    name = account_name(a)
    return {
        "HOME": home, "USER": name, "LOGNAME": name, "SHELL": "/bin/bash",
        "HERMES_HOME": f"{home}/.hermes", "PATH": AGENT_PATH,
        "TERM": "xterm-256color", "LANG": "C.UTF-8",
        "XDG_RUNTIME_DIR": str(RUN / "rt" / a["slug"]),
        "HERMES_PYTHON": "/opt/hermes/.venv/bin/python",
        "HERMES_RUNTIME_DIR": "/opt/hermes/tools",
        "HERMES_TUI_DIR": "/opt/hermes/ui-tui",
        "HERMES_WEB_DIST": "/opt/hermes/hermes_cli/web_dist",
        "PLAYWRIGHT_BROWSERS_PATH": "/opt/hermes/tools",
    }


def _drop(a: dict) -> dict:
    return {"user": a["uid"], "group": a["uid"], "extra_groups": [], "env": user_env(a),
            "cwd": str(home_of(a)), "start_new_session": True}


def run_as(a: dict, argv: list, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, **_drop(a))


def ensure_account(a: dict) -> None:
    """The passwd entry lives in the container, the home on the data disk, so
    the entry is recreated at boot with the same numeric id."""
    name, uid = account_name(a), a["uid"]
    try:
        pwd.getpwnam(name)
    except KeyError:
        subprocess.run(["groupadd", "--gid", str(uid), name], check=False, capture_output=True)
        subprocess.run(["useradd", "--uid", str(uid), "--gid", str(uid), "--no-create-home",
                        "--home-dir", str(home_of(a)), "--shell", "/bin/bash", name],
                       check=True, capture_output=True)
    home = home_of(a)
    home.mkdir(parents=True, exist_ok=True)
    os.chown(home, uid, uid)
    os.chmod(home, 0o700)
    for sub, mode, gid in (("rt", 0o700, uid), ("a", 0o750, WEB_GID)):
        d = RUN / sub / a["slug"]
        d.mkdir(parents=True, exist_ok=True)
        os.chown(d, uid, gid)
        os.chmod(d, mode)


SOUL = """# ECA Agent

You are the ECA agent for {name} ({role}) at Eastside Champions Athletics, a
group of four fitness clubs: Everett (06902), Wallingford (06904), Columbia
(40059) and Ballinger (40054).

You are a full working agent: you can research, write, run code in this
workspace, build reports and files, and schedule recurring work.

## ECA data

- ECA's numbers come from the `eca` tools. They are read-only and every call is
  logged under {name}'s name.
- Call `eca_whoami` first in a new conversation: it says which clubs this
  person may see. A refusal from a tool is final; do not look for another way
  to the same data.
- Before explaining a metric, call `eca_definitions`. Several ECA terms have
  more than one definition (New EFT, Champions).
- Never estimate or invent a number an ECA tool did not return. If the tools
  cannot answer, say so plainly.
- Say which club and which dates a number covers.

## Style

Plain English, short sentences, numbers first. No member names in reports
unless {name} asks for them.
"""


def provision(a: dict) -> None:
    """First-time setup of a leader's Hermes home. Safe to run again."""
    home = home_of(a)
    hh = home / ".hermes"
    r = run_as(a, [HERMES, "--version"], timeout=120)     # creates the home layout
    if r.returncode != 0:
        raise RuntimeError(f"hermes did not start for {a['slug']}: {(r.stderr or r.stdout)[-300:]}")
    cfg = hh / "config.yaml"
    if not a.get("provisioned") or not cfg.exists() or "mcp_servers" not in cfg.read_text():
        cfg.write_text(
            "model:\n"
            f"  provider: {PROVIDER}\n"
            f"  default: {DEFAULT_MODEL}\n"
            "webapp:\n"
            "  enabled: true\n"
            "  host: 127.0.0.1\n"
            f"  port: {a['port']}\n"
            "mcp_servers:\n"
            "  eca:\n"
            f"    url: {BACKEND}/api/intel/mcp\n"
            "    headers:\n"
            "      Authorization: \"Bearer ${ECA_GATEWAY_TOKEN}\"\n"
            "    timeout: 120\n"
        )
        os.chown(cfg, a["uid"], a["uid"])
        os.chmod(cfg, 0o600)
    soul = hh / "SOUL.md"
    marker = hh / ".eca-soul"
    if not marker.exists():
        soul.write_text(SOUL.format(name=a.get("name") or a.get("username") or "this leader",
                                    role=a.get("role") or "leader"))
        os.chown(soul, a["uid"], a["uid"])
        marker.write_text("1")
        os.chown(marker, a["uid"], a["uid"])
    env_file = hh / ".env"
    text = env_file.read_text() if env_file.exists() else ""
    if "ECA_GATEWAY_TOKEN=" not in text or not a.get("token_sha256"):
        token = secrets.token_urlsafe(40)
        lines = [ln for ln in text.splitlines() if not ln.startswith("ECA_GATEWAY_TOKEN=")]
        lines.append(f"ECA_GATEWAY_TOKEN={token}")
        env_file.write_text("\n".join(lines) + "\n")
        os.chown(env_file, a["uid"], a["uid"])
        os.chmod(env_file, 0o600)
        a["token_sha256"] = _h(token)
    if not (hh / "plugins" / PROVIDER).exists():
        r = run_as(a, [HERMES, "plugins", "install", PLUGIN, "--yes-deps", "--enable"], timeout=300)
        if not (hh / "plugins" / PROVIDER).exists():
            raise RuntimeError(f"claude plugin did not install: {(r.stdout + r.stderr)[-300:]}")
    a["provisioned"] = True
    with _lock:
        save_state()


# ───────────────────────────── processes ─────────────────────────────

def _pump(proc: subprocess.Popen, label: str) -> None:
    for line in iter(proc.stdout.readline, b""):
        try:
            print(f"[{label}] {line.decode('utf-8', 'replace').rstrip()[:400]}", flush=True)
        except Exception:
            pass


def _spawn(a: dict, argv: list, label: str) -> subprocess.Popen:
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, **_drop(a))
    threading.Thread(target=_pump, args=(proc, f"{label}:{a['slug']}"), daemon=True).start()
    return proc


def listener_uid(port: int):
    """Numeric owner of whatever listens on 127.0.0.1:<port>, or None."""
    want = f"0100007F:{port:04X}"
    try:
        with open("/proc/net/tcp") as fh:
            next(fh)
            for line in fh:
                f = line.split()
                if f[1] == want and f[3] == "0A":
                    return int(f[7])
    except Exception:
        return None
    return None


def webapp_state(port: int) -> str:
    """'ready', 'starting' or 'down' for the Webapp on a loopback port."""
    req = urllib.request.Request(f"http://127.0.0.1:{port}/", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=4) as r:
            return "ready" if r.status == 200 else "starting"
    except urllib.error.HTTPError as e:
        return "starting" if e.code == 503 else "ready"
    except Exception:
        return "down"


def _alive(proc) -> bool:
    return proc is not None and proc.poll() is None


def start_agent(a: dict) -> None:
    """Runs in a worker thread. Leaves a status the browser can poll."""
    slug = a["slug"]
    rt = _runtime.setdefault(slug, {})
    try:
        rt.update(status="starting", detail="Preparing your workspace")
        ensure_account(a)
        if not a.get("provisioned"):
            rt["detail"] = "Setting up your workspace for the first time (about a minute)"
        provision(a)
        sock = RUN / "a" / slug / "web.sock"
        if not _alive(rt.get("relay")):
            rt["relay"] = _spawn(a, ["socat", f"UNIX-LISTEN:{sock},fork,mode=666,unlink-early",
                                     f"TCP:127.0.0.1:{a['port']}"], "relay")
        rt["detail"] = "Starting your agent"
        owner = listener_uid(a["port"])
        if owner is not None and owner != a["uid"]:
            raise RuntimeError("the workspace port is held by another account")
        if webapp_state(a["port"]) == "down":
            if not _alive(rt.get("gateway")):
                rt["gateway"] = _spawn(a, [HERMES, "gateway", "run", "--quiet", "--no-supervise",
                                           "--external-supervisor"], "gateway")
            deadline = time.time() + 120
            while time.time() < deadline and webapp_state(a["port"]) == "down":
                if not _alive(rt.get("gateway")):
                    # The foreground gateway refused; let Hermes's own launcher start one.
                    log(f"{slug}: foreground gateway exited ({rt['gateway'].returncode}); using the launcher")
                    run_as(a, [HERMES, "webapp", "--no-open", "--skip-build"], timeout=150)
                    break
                time.sleep(1.5)
        deadline = time.time() + 120
        while time.time() < deadline and webapp_state(a["port"]) != "ready":
            time.sleep(1.5)
        if webapp_state(a["port"]) != "ready":
            raise RuntimeError("the agent did not come up in time")
        owner = listener_uid(a["port"])
        if owner is not None and owner != a["uid"]:
            raise RuntimeError("the workspace port is held by another account")
        rt.update(status="ready", detail="", last_seen=time.time(), listener_ok_at=time.time())
        log(f"{slug}: ready on port {a['port']}")
    except Exception as exc:
        log(f"{slug}: start failed: {exc}")
        rt.update(status="error", detail=str(exc)[:200])


def ensure_agent(identity: dict) -> dict:
    emp = str(identity["employee_number"])
    with _lock:
        a = _state["agents"].get(emp)
        if a is None:
            slug = "e" + re.sub(r"[^a-z0-9]", "", emp.lower())[:20]
            a = {"slug": slug, "uid": _state["next_uid"], "port": _state["next_port"],
                 "employee_number": emp, "created": int(time.time())}
            _state["next_uid"] += 1
            _state["next_port"] += 1
            _state["agents"][emp] = a
        a.update(name=identity.get("name"), username=identity.get("username"), role=identity.get("role"))
        save_state()
        rt = _runtime.setdefault(a["slug"], {"status": "new", "detail": ""})
        healthy = rt.get("status") == "ready" and webapp_state(a["port"]) == "ready"
        if not healthy and rt.get("status") != "starting":
            rt.update(status="starting", detail="Preparing your workspace")
            threading.Thread(target=start_agent, args=(a,), daemon=True).start()
    return a


def mint_launch_path(a: dict) -> str:
    """Ask the leader's own gateway for a one-use sign-in link and return its
    path and fragment. The link is never logged."""
    r = run_as(a, [HERMES, "webapp", "--no-open", "--skip-build"], timeout=120)
    m = re.search(r"https?://127\.0\.0\.1:%d(/\S+)" % a["port"], r.stdout or "")
    if not m:
        tail = re.sub(r"ticket=\S+", "ticket=<hidden>", (r.stdout or "") + (r.stderr or ""))[-300:]
        raise RuntimeError(f"no launch link from the gateway: {tail}")
    return m.group(1)


def stop_agent(a: dict) -> None:
    rt = _runtime.get(a["slug"]) or {}
    try:
        run_as(a, [HERMES, "gateway", "stop"], timeout=60)
    except Exception:
        pass
    for key in ("gateway", "relay"):
        proc = rt.get(key)
        if _alive(proc):
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except Exception:
                pass
    rt.update(status="new", detail="", gateway=None, relay=None)


def idle_reaper() -> None:
    while True:
        time.sleep(60)
        now = time.time()
        with _lock:
            for k in [k for k, s in _sessions.items() if s["expires"] < now]:
                _sessions.pop(k, None)
            agents = list(_state["agents"].values())
        if not IDLE_STOP_MINUTES:
            continue
        for a in agents:
            rt = _runtime.get(a["slug"]) or {}
            if rt.get("status") == "ready" and now - rt.get("last_seen", now) > IDLE_STOP_MINUTES * 60:
                log(f"{a['slug']}: idle, stopping")
                stop_agent(a)


# ───────────────────────────── backend ─────────────────────────────

def redeem_ticket(ticket: str):
    req = urllib.request.Request(
        f"{BACKEND}/api/intel/tickets/redeem", method="POST",
        data=json.dumps({"ticket": ticket}).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        log(f"ticket refused by the backend ({e.code})")
    except Exception as exc:
        log(f"backend unreachable for ticket redeem: {type(exc).__name__}")
    return None


# ───────────────────────────── pages ─────────────────────────────

PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>ECA Agent</title>
<style nonce="{nonce}">
:root{{color-scheme:dark}}
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#07130f;color:#eaf5ef;
font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}}
main{{width:min(92vw,460px);padding:32px;border:1px solid #1d3a2f;border-radius:20px;background:#0c1f18}}
h1{{font-size:20px;margin:0 0 6px}} p{{margin:8px 0;color:#a9c4b7}} .who{{color:#34d399;font-weight:600}}
.bar{{height:4px;border-radius:4px;background:#17332a;overflow:hidden;margin:18px 0 6px}}
.bar i{{display:block;height:100%;width:40%;background:#34d399;animation:s 1.4s ease-in-out infinite}}
@keyframes s{{0%{{margin-left:-40%}}100%{{margin-left:100%}}}}
button,a.btn{{display:inline-block;margin-top:14px;padding:10px 18px;border-radius:12px;border:0;
background:#10b981;color:#fff;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}}
small{{color:#6f8f80}}
</style></head><body><main>{body}</main>{script}</body></html>"""


def page(body: str, script: str = "") -> tuple:
    nonce = secrets.token_urlsafe(12)
    tag = f'<script nonce="{nonce}">{script}</script>' if script else ""
    doc = PAGE.format(nonce=nonce, body=body, script=tag)
    csp = (f"default-src 'none'; style-src 'nonce-{nonce}'; script-src 'nonce-{nonce}'; "
           "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    return doc.encode(), csp


START_JS = """
const d=document.getElementById('d');let n=0;
async function tick(){try{const r=await fetch('/_eca/status',{cache:'no-store',credentials:'same-origin'});
if(r.status===401){location.replace('/_eca/signed-out');return}
const s=await r.json();if(s.state==='ready'){location.replace('/_eca/open');return}
if(s.state==='error'){d.textContent='Something went wrong: '+s.detail+'. Go back to the portal and open your agent again.';return}
d.textContent=s.detail||'Starting your agent';}catch(e){}
if(++n<240)setTimeout(tick,1500)}tick();
"""


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "eca-supervisor"

    def log_message(self, *a):  # request lines carry tickets; never log them
        pass

    # helpers
    def _send(self, code: int, body: bytes = b"", ctype: str = "text/plain; charset=utf-8", headers: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _page(self, code: int, body: str, script: str = "", headers: dict | None = None):
        doc, csp = page(body, script)
        h = {"Content-Security-Policy": csp}
        h.update(headers or {})
        self._send(code, doc, "text/html; charset=utf-8", h)

    def _json(self, code: int, payload: dict):
        self._send(code, json.dumps(payload).encode(), "application/json")

    def _session(self):
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE and v:
                with _lock:
                    s = _sessions.get(_h(v))
                if s and s["expires"] > time.time():
                    return s
        return None

    def _agent(self, s):
        with _lock:
            return _state["agents"].get(s["emp"]) if s else None

    def _who(self, a) -> str:
        raw = (a or {}).get("name") or (a or {}).get("username") or "you"
        if "," in raw:
            raw = " ".join(p.strip() for p in reversed(raw.split(",", 1)))
        return html.escape(raw)

    # routes
    def do_GET(self):
        url = urlsplit(self.path)
        path = url.path
        if path == "/_auth":
            return self._auth()
        if path == "/_eca/health":
            return self._send(200, b"ok")
        if path == "/enter":
            return self._enter(parse_qs(url.query).get("ticket", [""])[0])
        if path == "/_eca/signed-out":
            return self._page(200, "<h1>ECA Agent</h1><p>Open your agent from the ECA portal. "
                                   "This page cannot be opened directly.</p>")
        s = self._session()
        if s is None:
            return self._send(302, headers={"Location": "/_eca/signed-out"})
        a = self._agent(s)
        if a is None:
            return self._send(302, headers={"Location": "/_eca/signed-out"})
        if path == "/_eca/start":
            if not s["confirmed"]:
                return self._confirm_page(a)
            ensure_agent({"employee_number": s["emp"], "name": a.get("name"),
                          "username": a.get("username"), "role": a.get("role")})
            return self._page(200, f"<h1>Starting your agent</h1><p>For <span class=who>{self._who(a)}</span></p>"
                                   "<div class=bar><i></i></div><p id=d>Preparing your workspace</p>"
                                   "<small>The first start takes about a minute.</small>", START_JS)
        if path == "/_eca/status":
            rt = _runtime.get(a["slug"]) or {}
            return self._json(200, {"state": rt.get("status", "new") if s["confirmed"] else "unconfirmed",
                                    "detail": rt.get("detail", "")})
        if path == "/_eca/open":
            if not s["confirmed"]:
                return self._send(302, headers={"Location": "/_eca/start"})
            rt = _runtime.get(a["slug"]) or {}
            if rt.get("status") != "ready":
                return self._send(302, headers={"Location": "/_eca/start"})
            try:
                target = mint_launch_path(a)
            except Exception as exc:
                log(f"{a['slug']}: {exc}")
                return self._page(502, "<h1>Could not open your agent</h1><p>The workspace is running but did "
                                       "not hand out a sign-in link. Go back to the portal and try again.</p>")
            return self._send(302, headers={"Location": target})
        return self._send(404, b"not found")

    do_HEAD = do_GET

    def do_POST(self):
        path = urlsplit(self.path).path
        length = min(int(self.headers.get("Content-Length") or 0), 8192)
        raw = self.rfile.read(length) if length else b""
        if path == "/internal/verify":
            try:
                token = str(json.loads(raw.decode() or "{}").get("token") or "")
            except Exception:
                token = ""
            if len(token) >= 20:
                digest = _h(token)
                with _lock:
                    for emp, a in _state["agents"].items():
                        if a.get("token_sha256") and secrets.compare_digest(a["token_sha256"], digest):
                            return self._json(200, {"employee_number": emp})
            return self._json(404, {"error": "unknown token"})
        s = self._session()
        if s is None:
            return self._send(401, b"signed out")
        if path == "/_eca/confirm":
            s["confirmed"] = True
            return self._send(303, headers={"Location": "/_eca/start"})
        if path == "/_eca/sign-out":
            with _lock:
                for k in [k for k, v in _sessions.items() if v is s]:
                    _sessions.pop(k, None)
            return self._send(303, headers={"Location": "/_eca/signed-out",
                                            "Set-Cookie": f"{COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"})
        return self._send(404, b"not found")

    def _confirm_page(self, a):
        return self._page(200, f"<h1>Open this workspace?</h1><p>This link opens the agent workspace of "
                               f"<span class=who>{self._who(a)}</span>.</p><p>If that is not you, close this page.</p>"
                               "<form method=post action=/_eca/confirm><button>Continue</button></form>")

    def _enter(self, ticket: str):
        identity = redeem_ticket(ticket) if 20 <= len(ticket) <= 200 else None
        if not identity or not identity.get("employee_number"):
            return self._page(403, "<h1>This link has expired</h1><p>Agent links work once and for a short time. "
                                   "Go back to the ECA portal and open your agent again.</p>")
        a = ensure_agent(identity)
        referer = self.headers.get("Referer") or ""
        origin = "{0.scheme}://{0.netloc}".format(urlsplit(referer)) if referer else ""
        value = secrets.token_urlsafe(40)
        with _lock:
            _sessions[_h(value)] = {"emp": str(identity["employee_number"]),
                                    "expires": time.time() + SESSION_HOURS * 3600,
                                    # A link followed from anywhere but the portal asks first, so nobody
                                    # can be dropped into someone else's workspace by a pasted link.
                                    "confirmed": origin in PORTAL_ORIGINS, "portal": origin}
        log(f"{a['slug']}: signed in from the portal")
        self._send(303, headers={
            "Location": "/_eca/start",
            "Set-Cookie": f"{COOKIE}={value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age={SESSION_HOURS * 3600}"})

    def _auth(self):
        """nginx asks, for every request to a workspace, whose it is."""
        s = self._session()
        a = self._agent(s)
        if not s or not a or not s["confirmed"]:
            return self._send(401)
        rt = _runtime.get(a["slug"]) or {}
        if rt.get("status") != "ready":
            return self._send(401)
        now = time.time()
        if now - rt.get("listener_ok_at", 0) > 5:
            owner = listener_uid(a["port"])
            if owner != a["uid"] and (owner is not None or webapp_state(a["port"]) == "down"):
                rt.update(status="error", detail="the workspace stopped")
                return self._send(401)
            rt["listener_ok_at"] = now
        rt["last_seen"] = now
        self._send(200, headers={"X-Agent-Slug": a["slug"], "X-Agent-Port": str(a["port"])})


def main() -> None:
    for d in (HOMES, STATE_FILE.parent, RUN / "a", RUN / "rt"):
        d.mkdir(parents=True, exist_ok=True)
    os.chmod(DATA, 0o711)
    os.chmod(HOMES, 0o711)
    os.chmod(RUN, 0o711)
    os.chmod(RUN / "a", 0o711)
    os.chmod(RUN / "rt", 0o711)
    load_state()
    with _lock:
        for a in _state["agents"].values():
            try:
                ensure_account(a)
            except Exception as exc:
                log(f"{a.get('slug')}: could not restore the account: {exc}")
    threading.Thread(target=idle_reaper, daemon=True).start()
    server = http.server.ThreadingHTTPServer((SUP_HOST, SUP_PORT), Handler)
    server.daemon_threads = True
    log(f"listening on {SUP_HOST}:{SUP_PORT}; backend {BACKEND}; {len(_state['agents'])} known workspaces")
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    server.serve_forever()


if __name__ == "__main__":
    main()
