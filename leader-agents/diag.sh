#!/bin/sh
# One-off diagnostic for ONE leader's workspace (ECA_DIAG_SLUG), run AS that leader.
# Prints the engine's recent errors and one tiny ChatGPT round trip. Secrets are masked.
# Remove ECA_DIAG_SLUG from the service settings when done.
SLUG="$1"; U="agent_$SLUG"; H="/srv/eca/agents/$SLUG"
mask() { sed -E 's/(eyJ[A-Za-z0-9_-]{8})[A-Za-z0-9._-]*/\1…/g; s/(eca_[A-Za-z0-9]{4})[A-Za-z0-9_-]*/\1…/g; s/(sk-[A-Za-z0-9]{4})[A-Za-z0-9_-]*/\1…/g; s/(Bearer )[^" ]+/\1…/g'; }
run() {
  echo "[diag] \$ $*"
  setpriv --reuid="$U" --regid="$U" --init-groups env -i HOME="$H" USER="$U" HERMES_HOME="$H/.hermes" \
    CODEX_HOME="$H/.codex" PATH=/usr/local/bin:/opt/hermes/bin:/opt/hermes/.venv/bin:/usr/bin:/bin \
    TZ=America/Los_Angeles TMPDIR="/run/eca/tmp/$SLUG" sh -c "cd $H && $*" 2>&1 | mask | tail -n 60 | sed 's/^/[diag]   /'
}
sleep 60
run "codex login status"
run "grep -E 'default:|provider:|openai_runtime' \$HERMES_HOME/config.yaml"
run "timeout 180 codex exec --skip-git-repo-check 'Use the eca MCP tool eca_whoami, then eca_all_clubs for yesterday. Reply in two lines: the clubs you can see, and each club total_cash_mtd.' </dev/null"
echo "[diag] ===== DONE ====="
