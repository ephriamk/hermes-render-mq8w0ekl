#!/bin/sh
# Round 2 fact finding on a throwaway container (no secrets, no disk).
# Anything that looks like a token, key or cookie value is masked.
set -u
mask() {
  sed -u -E \
    -e 's/([?&#](token|t|code|key|ticket|auth|session|otp|nonce|s)=)[A-Za-z0-9._~%+-]{8,}/\1<masked>/g' \
    -e 's/((TOKEN|KEY|SECRET|PASSWORD)[A-Z_]*=)[^ ]{6,}/\1<masked>/g' \
    -e 's/([Ss]et-[Cc]ookie: [^=]+=)[^;]+/\1<masked>/g'
}
sec() { echo; echo "===== $* ====="; }
# runn <max lines> <command...>   time-boxed at 60s
runn() { n="$1"; shift; echo "\$ $*"; timeout 60 "$@" 2>&1 | head -n "$n" | mask; echo "(done)"; }
# runl <seconds> <max lines> <command...>
runl() { t="$1"; n="$2"; shift 2; echo "\$ $*"; timeout "$t" "$@" 2>&1 | head -n "$n" | mask; echo "(done rc=$?)"; }

HB=/opt/hermes/.venv/bin/hermes
PY=/opt/hermes/.venv/bin/python
ROOT=/srv/eca/agents
BASEPATH="/usr/local/bin:/opt/hermes/bin:/opt/hermes/.venv/bin:$(dirname "$(command -v node)"):/usr/bin:/bin"

sec "limits"
runn 8 sh -c 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.current /sys/fs/cgroup/cpu.max 2>&1; echo PORT=${PORT:-unset}; echo RENDER=${RENDER:-unset} host=${RENDER_EXTERNAL_HOSTNAME:-unset}'
runn 6 sh -c 'command -v pnpm corepack yarn; ls /opt/hermes/tools | head -20'

sec "webapp bundle and sources"
runn 40 sh -c 'find /opt/hermes -maxdepth 5 \( -iname "*webapp*" -o -iname "*receipt*" \) -not -path "*/node_modules/*" -not -path "*/.venv/*" 2>/dev/null | head -40'
runn 30 sh -c 'ls /opt/hermes/apps; for d in /opt/hermes/apps/*; do echo "--- $d"; ls "$d" | head -20; done'
runn 60 sh -c 'grep -rIl -i "webapp" /opt/hermes --include=*.py 2>/dev/null | grep -v -E "/tests?/|/\.venv/|node_modules|/evals/" | head -60'
runn 420 sh -c 'cat /opt/hermes/hermes_cli/webapp_launcher.py'
runn 60 sh -c 'grep -n -i -B2 -A24 "^webapp:\|^  webapp:\|\"webapp\": {" /opt/hermes/cli-config.yaml.example /opt/hermes/hermes_cli/config.py 2>/dev/null | head -60'

WFILES="$(grep -rIl -i "webapp" /opt/hermes/gateway /opt/hermes/hermes_cli --include=*.py 2>/dev/null | grep -v -E "/tests?/" | head -60)"
runn 260 sh -c "grep -n -I -E 'public_url|trusted_prox|X-Forwarded|set_cookie|samesite|SameSite|check_origin|allowed_origin|_origin_ok|Origin\b|secure=|httponly|max_age=|cookie_name|COOKIE' $WFILES 2>/dev/null | cut -c1-240 | head -260"
runn 200 sh -c "grep -n -I -E 'add_(get|post|put|delete|route|static)\(|web\.(get|post|put|delete|route)\(|@routes\.|/ws\b|websocket|WebSocketResponse' $WFILES 2>/dev/null | cut -c1-220 | head -200"
runn 60 sh -c "grep -n -I -i -E 'pty|openpty|forkpty|terminal_rail|spawn.*shell|/bin/(ba)?sh' $WFILES 2>/dev/null | cut -c1-200 | head -60"
runn 40 sh -c "grep -n -I -i -E 'skin|theme|branding|customCSS|custom_css' $WFILES 2>/dev/null | cut -c1-200 | head -40"

sec "two linux accounts, homes outside /opt/data"
mkdir -p "$ROOT"; chmod 711 /srv/eca "$ROOT"
for u in probe probe2; do
  useradd -m -d "$ROOT/$u" -s /bin/bash "agent_$u" 2>&1 | head -2
  chmod 700 "$ROOT/$u"
done
runn 6 sh -c "ls -ld /srv/eca $ROOT $ROOT/probe $ROOT/probe2"
as() { u="$1"; shift; setpriv --reuid="agent_$u" --regid="agent_$u" --init-groups env -i HOME="$ROOT/$u" USER="agent_$u" LOGNAME="agent_$u" HERMES_HOME="$ROOT/$u/.hermes" PATH="$BASEPATH" TERM=xterm-256color LANG=C.UTF-8 "$@"; }
ASP="setpriv --reuid=agent_probe --regid=agent_probe --init-groups env -i HOME=$ROOT/probe USER=agent_probe LOGNAME=agent_probe HERMES_HOME=$ROOT/probe/.hermes PATH=$BASEPATH TERM=xterm-256color LANG=C.UTF-8"
ASP2="setpriv --reuid=agent_probe2 --regid=agent_probe2 --init-groups env -i HOME=$ROOT/probe2 USER=agent_probe2 LOGNAME=agent_probe2 HERMES_HOME=$ROOT/probe2/.hermes PATH=$BASEPATH TERM=xterm-256color LANG=C.UTF-8"
runn 6 $ASP sh -c 'id; cd; pwd; which hermes claude node'
runl 90 12 $ASP "$HB" --version
runl 60 10 $ASP "$HB" config set webapp.enabled true
runl 60 10 $ASP "$HB" config set webapp.host 127.0.0.1
runl 60 10 $ASP "$HB" config set webapp.port 9131
runn 40 $ASP sh -c 'ls -la $HERMES_HOME; echo ---; cat $HERMES_HOME/config.yaml 2>/dev/null | head -40'
runl 60 220 $ASP "$HB" config show

sec "isolation between accounts"
runn 8 $ASP2 sh -c "ls $ROOT/probe 2>&1 | head -2; cat $ROOT/probe/.hermes/config.yaml 2>&1 | head -1; ls /opt/data 2>&1 | head -1; ls /root 2>&1 | head -1; touch /opt/eca/x 2>&1 | head -1"

sec "claude plugin"
runl 240 60 $ASP "$HB" plugins install claude-subscription-directsdk --yes-deps --enable
runl 60 40 $ASP "$HB" plugins list
runn 30 $ASP sh -c 'ls -la $HERMES_HOME/plugins 2>&1; ls -la $HERMES_HOME/plugins/* 2>&1 | head -30'
runn 260 $ASP sh -c 'for f in $HERMES_HOME/plugins/*/README.md $HERMES_HOME/plugins/*/plugin.yaml; do echo "--- $f"; cat "$f" 2>/dev/null; done'
runl 60 30 $ASP "$HB" config get model
runl 60 30 $ASP "$HB" skin --help
runl 60 30 $ASP "$HB" skin list
runn 12 sh -c 'find /opt/hermes -maxdepth 4 -type d -iname "skins" -not -path "*/node_modules/*" | head; find /opt/hermes -maxdepth 5 -name "*.yaml" -path "*skins*" | head -12'
runn 90 sh -c 'f=$(find /opt/hermes -maxdepth 5 -name "*.yaml" -path "*skins*" | head -1); echo "--- $f"; cat "$f" 2>/dev/null'
runl 60 40 $ASP "$HB" mcp add --help
runl 60 20 $ASP "$HB" mcp test --help
runl 60 30 $ASP "$HB" gateway ensure --help
runl 60 30 $ASP "$HB" gateway tickets --help
runl 60 30 $ASP "$HB" gateway attach --help

sec "webapp start: let the launcher do it"
START=$(date +%s)
( cd "$ROOT/probe" && $ASP "$HB" webapp --no-open --skip-build > /tmp/webapp1.raw 2>&1 & )
i=0; UP=no
while [ $i -lt 60 ]; do
  if curl -s -o /dev/null -m 2 http://127.0.0.1:9131/; then UP=yes; echo "webapp answered after $(( $(date +%s) - START ))s"; break; fi
  i=$((i+2)); sleep 2
done
echo "launcher route up=$UP"
runn 60 sh -c 'cat /tmp/webapp1.raw'
if [ "$UP" = no ]; then
  sec "webapp start: foreground gateway under our own supervision"
  START=$(date +%s)
  ( cd "$ROOT/probe" && $ASP "$HB" gateway run --no-supervise --external-supervisor -v > /tmp/gw.raw 2>&1 & )
  i=0
  while [ $i -lt 90 ]; do
    if curl -s -o /dev/null -m 2 http://127.0.0.1:9131/; then UP=yes; echo "webapp answered after $(( $(date +%s) - START ))s"; break; fi
    i=$((i+2)); sleep 2
  done
  echo "gateway-run route up=$UP"
  runn 80 sh -c 'cat /tmp/gw.raw'
fi
runn 30 sh -c 'ss -ltnp 2>/dev/null'
runn 20 sh -c 'ps -eo user,pid,ppid,rss,etimes,args --sort=-rss | head -14 | cut -c1-200'
runl 60 20 $ASP "$HB" webapp --status
runl 60 20 $ASP "$HB" gateway status

sec "webapp sign-in flow (loopback)"
runn 30 sh -c 'curl -s -D - -o /dev/null -m 5 http://127.0.0.1:9131/'
runn 12 sh -c 'curl -s -m 5 http://127.0.0.1:9131/ | head -c 1200; echo'
timeout 60 $ASP "$HB" webapp --no-open --skip-build > /tmp/link.raw 2>&1
runn 20 sh -c 'cat /tmp/link.raw'
LINK="$(grep -oE 'https?://[^ ]+' /tmp/link.raw | head -1)"
echo "link shape: $(echo "$LINK" | mask)"
if [ -n "$LINK" ]; then
  LOCAL="http://127.0.0.1:9131/$(echo "$LINK" | sed -E 's#^https?://[^/]+/?##')"
  echo "following (loopback): $(echo "$LOCAL" | mask)"
  runn 40 sh -c "curl -s -D - -o /tmp/signin.body -m 10 -c /tmp/jar -H 'Host: eca-agents-trial.onrender.com' -H 'X-Forwarded-Proto: https' -H 'X-Forwarded-Host: eca-agents-trial.onrender.com' '$LOCAL'"
  runn 8 sh -c 'head -c 600 /tmp/signin.body; echo; echo "jar cookies:"; awk "!/^#/ && NF {print \$1, \$2, \$3, \$4, \$6, \"<value masked, len \" length(\$7) \">\"}" /tmp/jar'
  runn 30 sh -c "curl -s -D - -o /tmp/home.body -m 10 -b /tmp/jar -H 'Host: eca-agents-trial.onrender.com' -H 'X-Forwarded-Proto: https' http://127.0.0.1:9131/"
  runn 40 sh -c "head -c 2500 /tmp/home.body; echo; echo '--- referenced paths'; grep -oE '(src|href|action)=\"[^\"]+\"' /tmp/home.body | sort -u | head -40"
  echo "second use of the same link:"
  runn 12 sh -c "curl -s -D - -o /dev/null -m 10 '$LOCAL' | head -8"
  echo "cookie from a different Origin:"
  runn 12 sh -c "curl -s -D - -o /dev/null -m 10 -b /tmp/jar -H 'Origin: https://evil.example' http://127.0.0.1:9131/ | head -6"
fi

sec "what one account can see of another's running agent"
GP="$(pgrep -u agent_probe -f hermes | head -1)"
echo "probe gateway pid=$GP"
runn 8 $ASP2 sh -c "cat /proc/$GP/environ 2>&1 | head -c 200; echo; ls /proc/$GP/cwd 2>&1 | head -2; curl -s -o /dev/null -w 'loopback webapp from another account: %{http_code}\n' -m 3 http://127.0.0.1:9131/"
runn 6 sh -c 'cat /sys/fs/cgroup/memory.current; free -m | sed -n 2p'
echo "===== END ====="
