#!/bin/sh
# One-off facts about running OpenAI's Codex program for a leader on this server.
# Runs at start only when ECA_CODEX_PROBE=1. Uses a throwaway account; prints no secrets.
set -u
say() { echo "[codexprobe] $*"; }
run() { say "\$ $*"; timeout 60 "$@" 2>&1 | head -n 60 | sed 's/^/[codexprobe]   /'; say "(rc=$?)"; }
HB=/opt/hermes/bin/hermes
H=/srv/eca/probe-codex
useradd -m -d "$H" -s /bin/bash agent_cxprobe 2>/dev/null; chmod 700 "$H"
AS="setpriv --reuid=agent_cxprobe --regid=agent_cxprobe --init-groups env -i HOME=$H USER=agent_cxprobe LOGNAME=agent_cxprobe HERMES_HOME=$H/.hermes CODEX_HOME=$H/.codex PATH=/usr/local/bin:/opt/hermes/bin:/opt/hermes/.venv/bin:/usr/bin:/bin TERM=xterm-256color TZ=America/Los_Angeles"
run $AS codex --version
run $AS codex login --help
run $AS codex login status
run $AS codex sandbox --help
run $AS sh -c 'codex sandbox linux -- /bin/echo sandbox-ok || codex debug landlock -- /bin/echo sandbox-ok'
run $AS $HB --version
run $AS $HB codex-runtime --help
run $AS $HB codex-runtime migrate --help
run $AS $HB auth add --help
run $AS sh -c "mkdir -p \$HERMES_HOME && printf 'model:\n  provider: openai-codex\n  default: gpt-5.4\n  openai_runtime: codex_app_server\nmcp_servers:\n  eca:\n    url: https://example.invalid/api/intel/mcp\n    headers:\n      Authorization: \"Bearer \${ECA_GATEWAY_TOKEN}\"\n    timeout: 120\n' > \$HERMES_HOME/config.yaml"
run $AS $HB codex-runtime migrate --dry-run --json
run $AS $HB codex-runtime migrate
run $AS sh -c 'cat $CODEX_HOME/config.toml 2>/dev/null | sed "s/Bearer [^\"]*/Bearer <hidden>/" | head -60'
run $AS $HB config get model
run $AS $HB model --help
userdel -r agent_cxprobe 2>/dev/null; rm -rf "$H"
say "===== DONE ====="
