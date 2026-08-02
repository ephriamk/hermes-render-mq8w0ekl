#!/usr/bin/env bash
# ECA queue watchdog. PT agreements use the bounded direct reader; all other
# payroll jobs retain the general Hermes agent. One atomic lock covers the
# whole invocation, so cron can never overlap either execution path.
set -u

ENVF=${ECA_WATCHDOG_ENV_FILE:-/opt/data/.env}
WAKE_DIR=${ECA_WATCHDOG_WAKE_DIR:-/tmp}
PT_WORKER=${ECA_PT_WORKER_PATH:-/opt/data/scripts/pt_agreement_worker.py}
RUN_LOCK=${ECA_WATCHDOG_RUN_LOCK:-/tmp/eca_payroll_watchdog.lock}
API=$(grep '^ECA_API_BASE_URL=' "$ENVF" 2>/dev/null | cut -d= -f2-); API=${API:-https://ecacombined-1.onrender.com}
KEY=$(grep '^API_SERVER_KEY=' "$ENVF" 2>/dev/null | cut -d= -f2-)
PORT=$(grep '^API_SERVER_PORT=' "$ENVF" 2>/dev/null | cut -d= -f2-); PORT=${PORT:-8788}
TOK=$(grep '^ECA_HERMES_SERVICE_TOKEN=' "$ENVF" 2>/dev/null | cut -d= -f2-)

exec 9>"$RUN_LOCK"
if ! flock -n 9; then
  exit 0
fi

# This reader claims only parse_pt_agreement_v1 and at most one asset. It always
# finishes before any general agent starts, keeping memory bounded while also
# preventing a PT backlog from starving time-sensitive payroll work.
if [ -x "$PT_WORKER" ]; then
  PT_OUTPUT=$($PT_WORKER 2>&1)
  PT_RC=$?
  case "$PT_RC" in
    0) ;;
    10|20|21) [ -z "$PT_OUTPUT" ] || printf '%s\n' "$PT_OUTPUT" ;;
    75) exit 0 ;;
    *) [ -z "$PT_OUTPUT" ] || printf '%s\n' "$PT_OUTPUT"; exit 0 ;;
  esac
else
  echo "payroll watchdog: direct PT worker is missing or not executable" >&2
  exit 0
fi

# PT queue is empty. Ask only about jobs owned by the general agent. The
# fallback keys keep this safe during a rolling backend deploy.
COUNTS=$(curl -s --max-time 12 -H "Authorization: Bearer $TOK" "$API/api/v4/agent/status" \
  | python3 -c "import sys,json; q=json.load(sys.stdin).get('queue') or {}; print(int(q.get('agent_queued',q.get('queued',0))), int(q.get('agent_claimed',q.get('claimed',0))))" 2>/dev/null || echo "0 0")
QUEUED=${COUNTS%% *}
CLAIMED=${COUNTS##* }
case "$QUEUED" in ''|*[!0-9]*) QUEUED=0 ;; esac
case "$CLAIMED" in ''|*[!0-9]*) CLAIMED=0 ;; esac
[ "$QUEUED" -gt 0 ] || exit 0
[ "$CLAIMED" -eq 0 ] || exit 0

STAMP=$(date +%Y%m%d%H%M%S)
SID="eca-payroll-$STAMP"
WAKE_FILE="$WAKE_DIR/payroll_wake_$STAMP.json"
cat > "$WAKE_FILE" <<JSON
{"model":"hermes-agent","messages":[{"role":"user","content":"Process exactly ONE ECA payroll or compensation-plan worker job, then exit. Load and follow the eca-payroll-parse-plan skill. Make one claim request with \"worker_label\": \"single-$STAMP-w1\". Never request or process parse_pt_agreement_v1; the direct verified PT reader exclusively owns that job type. Never claim a second job. Complete, fail, or release the one claimed job only through its documented endpoint, then stop."}]}
JSON

# Foreground execution is intentional: the filesystem lock remains held for
# the full gateway request. A short backend poll closes the race where a
# gateway response finishes just before its agent's final API write.
curl -s --max-time 1800 -X POST "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "X-Hermes-Session-Id: $SID" -H "X-Hermes-Session-Key: $SID" \
  --data-binary "@$WAKE_FILE" >/dev/null 2>&1

for _poll in 1 2 3 4 5 6; do
  STILL_CLAIMED=$(curl -s --max-time 12 -H "Authorization: Bearer $TOK" "$API/api/v4/agent/status" \
    | python3 -c "import sys,json; q=json.load(sys.stdin).get('queue') or {}; print(int(q.get('agent_claimed',q.get('claimed',0))))" 2>/dev/null || echo 0)
  case "$STILL_CLAIMED" in ''|*[!0-9]*) STILL_CLAIMED=0 ;; esac
  [ "$STILL_CLAIMED" -gt 0 ] || break
  sleep 10
done

echo "payroll watchdog: $QUEUED general job(s) queued -> ran one isolated agent ($STAMP)"
