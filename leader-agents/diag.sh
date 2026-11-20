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
run "ls -la \$HERMES_HOME/logs 2>/dev/null"
run "for f in \$HERMES_HOME/logs/*.log; do echo == \$f; grep -iE 'error|exception|traceback|failed|denied|sandbox|401|403|429|model' \$f | tail -n 25; done"
run "timeout 120 codex exec --skip-git-repo-check 'Reply with exactly: ok' </dev/null"
run "timeout 60 codex exec --skip-git-repo-check -m gpt-5.4 'Reply with exactly: ok' </dev/null"
run "sed -n '1,40p' \$CODEX_HOME/config.toml"
echo "[diag] ===== DONE ====="
