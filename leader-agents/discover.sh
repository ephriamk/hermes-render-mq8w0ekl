#!/bin/sh
# Read-only fact finding on a throwaway container. Anything that looks like a
# token or key is masked before it reaches the logs.
set -u
mask() {
  sed -u -E \
    -e 's/([?&#](token|t|code|key|ticket|auth|session)=)[A-Za-z0-9._~%+-]{8,}/\1<masked>/g' \
    -e 's/((TOKEN|KEY|SECRET|PASSWORD)[A-Z_]*=)[^ ]{6,}/\1<masked>/g'
}
sec() { echo; echo "===== $* ====="; }
# runn <max lines> <command...>   (every command is time-boxed)
runn() {
  n="$1"; shift
  echo "\$ $*"
  timeout 60 "$@" 2>&1 | head -n "$n" | mask
  echo "(done)"
}

HB=/opt/hermes/.venv/bin/hermes
PY=/opt/hermes/.venv/bin/python
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
NODE_BIN="$(command -v node 2>/dev/null || true)"
EXTRA_PATH=""
[ -n "$CLAUDE_BIN" ] && EXTRA_PATH="$(dirname "$CLAUDE_BIN"):"
[ -n "$NODE_BIN" ] && EXTRA_PATH="${EXTRA_PATH}$(dirname "$NODE_BIN"):"

sec "system"
runn 20 sh -c 'head -3 /etc/os-release; id; nproc; free -m | head -2; df -h /opt/data 2>/dev/null | tail -1'
runn 30 sh -c 'for b in hermes node npm python3 nginx openssl useradd gosu s6-setuidgid setpriv runuser su tini claude uv git timeout ss; do printf "%s -> " "$b"; command -v "$b" || echo MISSING; done'
runn 12 sh -c 'node --version; npm --version; npm prefix -g; python3 --version; '"$PY"' --version; claude --version; nginx -v'
runn 30 sh -c 'env | grep -E "^(HERMES|XDG|PLAYWRIGHT|PATH|HOME|USER)" | sort'

sec "image layout"
runn 60 sh -c 'ls /opt/hermes'
runn 30 sh -c 'ls /opt/hermes/docker 2>/dev/null; echo ---; ls /opt/hermes/bin 2>/dev/null'
runn 140 sh -c 'cat /opt/hermes/docker/entrypoint-dispatch.sh 2>/dev/null'
runn 80 sh -c 'find /etc/s6-overlay /etc/services.d /etc/cont-init.d -maxdepth 4 2>/dev/null'
runn 220 sh -c 'for f in $(find /etc/s6-overlay/s6-rc.d \( -name run -o -name up \) 2>/dev/null | head -14); do echo "--- $f"; cat "$f"; done'

sec "python libraries available to a supervisor"
for m in aiohttp httpx cryptography jwt yaml fastapi uvicorn websockets starlette; do
  printf "%s: " "$m"; timeout 20 "$PY" -c "import $m; print(getattr($m,'__version__','ok'))" 2>&1 | tail -1
done

sec "hermes cli"
runn 5 "$HB" --version
runn 100 "$HB" --help
runn 60 "$HB" webapp --help
runn 50 "$HB" gateway --help
runn 40 "$HB" gateway run --help
runn 40 "$HB" dashboard --help
runn 40 "$HB" plugins --help
runn 40 "$HB" plugins install --help
runn 40 "$HB" config --help
runn 40 "$HB" auth --help
runn 30 "$HB" model --help
runn 30 "$HB" profile create --help
runn 30 "$HB" tools --help
runn 30 "$HB" mcp --help
runn 30 "$HB" skills --help

sec "second linux account with its own hermes home"
H=/opt/data/agents/probe
mkdir -p /opt/data/agents
runn 5 useradd -m -d "$H" -s /bin/bash agent_probe
runn 6 sh -c "chmod 700 $H; ls -ld $H /opt/data /opt/data/agents"
AS="setpriv --reuid=agent_probe --regid=agent_probe --init-groups env -i HOME=$H USER=agent_probe LOGNAME=agent_probe HERMES_HOME=$H/.hermes PATH=${EXTRA_PATH}/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin:/bin TERM=xterm-256color"
echo "AS = $AS"
runn 5 $AS "$HB" --version
runn 10 $AS sh -c 'id; echo HOME=$HOME; echo HERMES_HOME=$HERMES_HOME; touch /opt/hermes/x 2>&1 | head -1'
runn 6 $AS sh -c 'ls /opt/data 2>&1 | head -5; cat /opt/data/.env 2>&1 | head -1'
runn 20 $AS "$HB" config set webapp.enabled true
runn 20 $AS "$HB" config set webapp.host 127.0.0.1
runn 20 $AS "$HB" config set webapp.port 9131
runn 70 $AS sh -c 'ls -la $HERMES_HOME; echo ---; cat $HERMES_HOME/config.yaml 2>/dev/null | head -60'
runn 30 $AS "$HB" webapp --status
runn 60 $AS "$HB" tools --summary

sec "claude plugin and claude program"
runn 60 $AS "$HB" plugins install claude-subscription-directsdk --yes-deps
runn 40 $AS "$HB" plugins list
runn 20 $AS sh -c 'ls -la $HERMES_HOME/plugins 2>/dev/null; find $HERMES_HOME/plugins -maxdepth 2 -name plugin.yaml 2>/dev/null | head'
runn 20 $AS claude auth status
runn 30 $AS claude auth login --help
runn 20 $AS claude setup-token --help

sec "webapp start as the probe account"
( $AS "$HB" webapp --no-open > /tmp/webapp.log 2>&1 & )
i=0
while [ $i -lt 75 ]; do
  if curl -s -o /dev/null -m 2 http://127.0.0.1:9131/; then echo "webapp answered after ${i}s"; break; fi
  i=$((i+3)); sleep 3
done
runn 80 sh -c 'cat /tmp/webapp.log'
runn 30 sh -c 'curl -s -D - -o /dev/null -m 5 http://127.0.0.1:9131/'
runn 12 sh -c 'curl -s -m 5 http://127.0.0.1:9131/ | head -c 1500; echo'
runn 20 sh -c 'curl -s -D - -o /dev/null -m 5 -H "Host: example.onrender.com" -H "X-Forwarded-Proto: https" -H "X-Forwarded-For: 203.0.113.9" http://127.0.0.1:9131/'
runn 30 sh -c 'ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null'
runn 20 sh -c 'ps -eo user,pid,rss,etimes,args --sort=-rss | head -16 | cut -c1-220'
runn 30 $AS "$HB" webapp --status
runn 20 $AS "$HB" gateway status
runn 90 $AS sh -c 'ls -la $HERMES_HOME; echo ---; cat $HERMES_HOME/config.yaml | head -80'
runn 20 sh -c 'find /opt/hermes -maxdepth 3 -iname "*skin*" | head -10; find /opt/hermes -maxdepth 3 -iname "*webapp*" | head -10'
runn 10 sh -c 'free -m | head -2'
