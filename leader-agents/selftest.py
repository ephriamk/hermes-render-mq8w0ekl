"""Separation self-test: proves, on the real server, that one leader's account
cannot reach another's workspace.

Runs only when ECA_SELFTEST=1. It creates two throwaway accounts (no leader, no
ECA data, no model), starts a real Hermes workspace for the first, then tries
from the second account (and from root) everything that must be refused. Each
check prints one line: PASS, FAIL, or INFO for a fact worth knowing. It then
removes both accounts and their folders.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time

PROBE = r'''
import json, sys, urllib.request, urllib.error, socket
req = json.load(sys.stdin); out = {}
for name, r in req.items():
    try:
        if r.get("unix"):
            s = socket.socket(socket.AF_UNIX); s.settimeout(3); s.connect(r["unix"]); s.close(); out[name] = "connected"
            continue
        q = urllib.request.Request(r["url"], method=r.get("method", "GET"), headers=r.get("headers", {}),
                                   data=b"" if r.get("method") == "POST" else None)
        with urllib.request.urlopen(q, timeout=8) as resp:
            body = resp.read(4000).decode("utf-8", "replace")
            out[name] = {"code": resp.status, "body": body if r.get("want_body") else ""}
    except urllib.error.HTTPError as e:
        out[name] = {"code": e.code, "body": ""}
    except Exception as e:
        out[name] = "refused:" + type(e).__name__
json.dump(out, sys.stdout)
'''


def run(sup) -> None:
    def say(kind: str, what: str) -> None:
        print(f"[selftest] {kind} {what}", flush=True)

    def check(ok: bool, what: str) -> None:
        say("PASS" if ok else "FAIL", what)

    def sh(a, cmd: str):
        return sup.run_as(a, ["/bin/sh", "-c", cmd], timeout=40)

    def probe(a, reqs: dict) -> dict:
        r = sup.run_as(a, [sup.PY, "-I", "-c", PROBE], timeout=60, stdin=json.dumps(reqs))
        try:
            return json.loads(r.stdout)
        except Exception:
            return {}

    root = sup.DATA / "selftest"
    A = {"slug": "zzta", "uid": 29991, "port": 9191, "employee_number": "selftest-a", "name": "Self Test A",
         "home": str(root / "zzta")}
    B = {"slug": "zztb", "uid": 29992, "port": 9192, "employee_number": "selftest-b", "name": "Self Test B",
         "home": str(root / "zztb")}
    try:
        time.sleep(3)
        say("INFO", "starting")
        # ── what this server lets us use ──
        caps = ""
        try:
            for line in open("/proc/self/status"):
                if line.startswith(("CapEff", "CapBnd", "NoNewPrivs", "Seccomp")):
                    caps += line.strip().replace("\t", " ") + "; "
        except Exception:
            pass
        say("INFO", f"root capabilities: {caps}")
        for name, cmd in (("private folder views (mount namespace)", "unshare --mount true"),
                          ("private process lists (pid namespace)", "unshare --pid --fork true"),
                          ("user namespaces", "unshare --user --map-root-user true"),
                          ("hidden process lists (hidepid)", "mkdir -p /run/eca/ptest && mount -t proc -o hidepid=2 proc /run/eca/ptest && umount /run/eca/ptest"),
                          ("per-account network rules (iptables)", "iptables -S >/dev/null")):
            r = subprocess.run(["/bin/sh", "-c", cmd], capture_output=True, text=True, timeout=20)
            say("INFO", f"available: {name}: {'yes' if r.returncode == 0 else 'no'}")

        root.mkdir(parents=True, exist_ok=True)
        os.chmod(root, 0o711)
        for x in (A, B):
            sup.ensure_account(x)
        sup._runtime[A["slug"]] = {"status": "new"}
        t = threading.Thread(target=sup.start_agent, args=(A,), kwargs={"bare": True})
        t.start()
        t.join(300)
        rt = sup._runtime.get(A["slug"]) or {}
        check(rt.get("status") == "ready", f"a workspace starts for account A ({rt.get('detail') or 'ok'})")
        if rt.get("status") != "ready":
            return
        gw = rt["gateway"].pid
        sh(A, "echo private-a > $HOME/notes.txt; echo private-a > /tmp/eca-selftest-a.txt; "
              "echo private-a > /dev/shm/eca-selftest-a.txt; echo private-a > $TMPDIR/scratch.txt")

        # ── files ──
        r = sh(A, "stat -c %a $HOME/notes.txt /tmp/eca-selftest-a.txt $HOME/.hermes $HOME/.hermes/config.yaml; echo $TMPDIR")
        say("INFO", "A's own file modes and temp folder: " + " ".join(r.stdout.split()))
        home = A["home"]
        for what, cmd in (
            ("B cannot list A's home", f"ls {home}"),
            ("B cannot read a file in A's home", f"cat {home}/notes.txt"),
            ("B cannot read A's Hermes settings", f"cat {home}/.hermes/config.yaml"),
            ("B cannot read A's file in the shared /tmp", "cat /tmp/eca-selftest-a.txt"),
            ("B cannot read A's file in shared memory", "cat /dev/shm/eca-selftest-a.txt"),
            ("B cannot enter A's private temp folder", f"ls {sup.RUN}/tmp/zzta"),
            ("B cannot enter A's runtime folder", f"ls {sup.RUN}/rt/zzta"),
            ("B cannot enter A's relay folder", f"ls {sup.RUN}/a/zzta"),
            ("B cannot read the supervisor's account list", f"cat {sup.STATE_FILE}"),
            ("B cannot list the workspaces folder", f"ls {sup.HOMES}"),
            ("B cannot write into the server's own program folder", "touch /opt/eca/x"),
            ("B cannot write into Hermes's program folder", "touch /opt/hermes/x"),
        ):
            check(sh(B, cmd).returncode != 0, what)

        # ── nothing a leader can change is run by root ──
        r = sh(B, "find /opt/hermes /opt/eca /opt/eca-vendor /usr/local /usr/bin /usr/sbin /etc /run/eca/a "
                  "-xdev -writable 2>/dev/null | head -5")
        check(not r.stdout.strip(), "B can write nothing in the program folders, /etc or the relay folders"
              + (f" (found: {r.stdout.split()[:3]})" if r.stdout.strip() else ""))
        check(sh(B, f"ln -sf {sup.RUN}/a/zztb/web.sock {sup.RUN}/a/zzta/web.sock").returncode != 0,
              "B cannot replace A's relay socket")
        check(sh(A, f"ln -sf /tmp/x {sup.RUN}/a/zzta/web.sock").returncode != 0,
              "A cannot replace its own relay socket either (root-owned folder)")

        # ── processes ──
        check(sh(B, f"cat /proc/{gw}/environ").returncode != 0, "B cannot read the environment of A's agent")
        check(sh(B, f"ls /proc/{gw}/cwd/").returncode != 0, "B cannot look into A's agent's working folder")
        check(sh(B, f"ls /proc/{gw}/fd").returncode != 0, "B cannot see A's agent's open files")
        check(sh(B, f"kill -0 {gw}").returncode != 0, "B cannot signal A's agent")
        r = sh(B, f"tr '\\0' ' ' < /proc/{gw}/cmdline | cut -c1-80")
        say("INFO", "B can see the command line of A's processes: " + ("yes" if r.stdout.strip() else "no")
            + " (names of programs and their arguments, not their contents)")

        # ── sockets ──
        res = probe(B, {"relay": {"unix": f"{sup.RUN}/a/zzta/web.sock"},
                        "supervisor": {"unix": str(sup.SUP_SOCK)}})
        check(res.get("relay") != "connected", "B cannot connect to A's relay")
        check(res.get("supervisor") != "connected", "B cannot connect to the supervisor directly")

        # ── A's Webapp over the shared loopback ──
        base = f"http://127.0.0.1:{A['port']}"
        open_paths = {"sessions": "/api/sessions?limit=1", "config": "/api/config", "profiles": "/api/profiles",
                      "files": f"/api/fs/list?path={home}", "preferences": "/api/ui-preferences",
                      "cron": "/api/cron/jobs", "status": "/api/status", "health": "/api/health"}
        res = probe(B, {k: {"url": base + v, "want_body": k in ("status", "health")} for k, v in open_paths.items()})
        for k in ("sessions", "config", "profiles", "files", "preferences", "cron"):
            code = (res.get(k) or {}).get("code") if isinstance(res.get(k), dict) else res.get(k)
            check(code != 200, f"B gets nothing from A's workspace API without A's key: {k} ({code})")
        for k in ("status", "health"):
            v = res.get(k)
            if isinstance(v, dict) and v.get("code") == 200:
                say("INFO", f"open to any local account on A's port: /api/{k} -> {v.get('body', '')[:160]}")

        link = sup.mint_launch_path(A)                 # one-use ticket, kept in memory, never printed
        ticket = link.split("ticket=", 1)[1].split("&", 1)[0]
        spend = {"spend": {"url": base + "/webapp/window-session", "method": "POST", "want_body": True,
                           "headers": {"Origin": base, "X-Hermes-Window-Ticket": ticket}}}
        code_b = (probe(B, spend).get("spend") or {})
        check(not (isinstance(code_b, dict) and code_b.get("code") == 200),
              f"B cannot spend A's one-use sign-in link ({code_b.get('code') if isinstance(code_b, dict) else code_b})")
        r = subprocess.run([sup.PY, "-I", "-c", PROBE], input=json.dumps(spend), capture_output=True, text=True, timeout=30)
        try:
            code_root = json.loads(r.stdout).get("spend")
        except Exception:
            code_root = "error"
        check(not (isinstance(code_root, dict) and code_root.get("code") == 200),
              "even the server's own root account cannot spend it (only A's account can)")
        got_a = probe(A, spend).get("spend") or {}
        ok_a = isinstance(got_a, dict) and got_a.get("code") == 200
        check(ok_a, "A's own account can spend it (the link works for its owner)")
        if ok_a:
            try:
                key = json.loads(got_a["body"])["token"]
            except Exception:
                key = ""
            if key:
                res = probe(B, {"with_key": {"url": base + "/api/sessions?limit=1",
                                             "headers": {"Authorization": "Bearer " + key}}})
                v = res.get("with_key")
                say("INFO", "A's workspace key would work from another local account if that account ever "
                            "obtained it: " + ("yes" if isinstance(v, dict) and v.get("code") == 200 else "no")
                    + " (it is kept in A's private home and in A's own browser tab only)")

        # ── a squatter on A's port is refused ──
        sup.stop_agent(A, wait=8)
        time.sleep(1.5)
        squat = subprocess.Popen([sup.PY, "-I", "-c",
                                  f"import http.server; http.server.HTTPServer(('127.0.0.1', {A['port']}), "
                                  "http.server.SimpleHTTPRequestHandler).serve_forever()"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **sup._drop(B))
        time.sleep(2.5)
        owner = sup.listener_uid(A["port"])
        check(owner == B["uid"], f"(set-up) account B now holds A's port (owner uid {owner})")
        sup._runtime[A["slug"]] = {"status": "new"}
        t = threading.Thread(target=sup.start_agent, args=(A,), kwargs={"bare": True})
        t.start()
        t.join(60)
        check((sup._runtime.get(A["slug"]) or {}).get("status") == "error",
              "the supervisor refuses to send A's browser to a port held by B")
        sup.signal_as(B, "KILL")
    except Exception as exc:
        say("FAIL", f"self-test stopped early: {type(exc).__name__}: {str(exc)[:160]}")
    finally:
        for x in (A, B):
            try:
                sup.stop_agent(x, wait=5)
            except Exception:
                pass
            time.sleep(0.5)
            subprocess.run(["userdel", sup.account_name(x)], capture_output=True)
            subprocess.run(["groupdel", sup.account_name(x)], capture_output=True)
            sup._runtime.pop(x["slug"], None)
            for d in ("rt", "tmp", "a"):
                shutil.rmtree(sup.RUN / d / x["slug"], ignore_errors=True)
        shutil.rmtree(root, ignore_errors=True)
        for f in ("/tmp/eca-selftest-a.txt", "/dev/shm/eca-selftest-a.txt"):
            try:
                os.unlink(f)
            except OSError:
                pass
        say("INFO", "finished; test accounts removed")
