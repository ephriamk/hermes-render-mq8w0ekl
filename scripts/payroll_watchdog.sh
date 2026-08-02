#!/usr/bin/env bash
# Zero-token ECA queue watchdog (cron --no-agent). v3: postdates-aware.
# Every tick: one cheap HTTP check of the backend queue. Wake Hermes only when
# work exists. Each fresh session is permitted to claim exactly one backend job;
# this bounds context growth and prevents one job's memory contaminating another.
# The Render service has 2 GB RAM, so the safe default is deliberately one
# worker; ECA_MAX_PAYROLL_WORKERS can opt into more later. Empty stdout = silent.
set -u
ENVF=${ECA_WATCHDOG_ENV_FILE:-/opt/data/.env}
PIDDIR=${ECA_WATCHDOG_PID_DIR:-/tmp/payroll_watchdog.pids}
WAKE_DIR=${ECA_WATCHDOG_WAKE_DIR:-/tmp}
API=$(grep '^ECA_API_BASE_URL=' "$ENVF" | cut -d= -f2-); API=${API:-https://ecacombined-1.onrender.com}
KEY=$(grep '^API_SERVER_KEY=' "$ENVF" | cut -d= -f2-)
PORT=$(grep '^API_SERVER_PORT=' "$ENVF" | cut -d= -f2-); PORT=${PORT:-8788}
MAXW=$(grep '^ECA_MAX_PAYROLL_WORKERS=' "$ENVF" | cut -d= -f2-); MAXW=${MAXW:-1}
TOK=$(grep '^ECA_HERMES_SERVICE_TOKEN=' "$ENVF" | cut -d= -f2-)
case "$MAXW" in ''|*[!0-9]*) MAXW=1 ;; esac
[ "$MAXW" -gt 0 ] || MAXW=1

# NOTE: /api/v4 is auth-gated (2026-07-01) — an unauthenticated check gets 401,
# parses as queued=0, and the watchdog never wakes (this silently killed the
# cloud worker for 3 days). The bearer header is load-bearing.
QUEUED=$(curl -s --max-time 12 -H "Authorization: Bearer $TOK" "$API/api/v4/agent/status" \
  | python3 -c "import sys,json; print(int((json.load(sys.stdin).get('queue') or {}).get('queued',0)))" 2>/dev/null || echo 0)
[ "$QUEUED" -gt 0 ] || exit 0

# Enforce MAXW across wake rounds, not just within one cron tick. A PT batch
# can take longer than the 3-minute debounce; without an active-process guard,
# every third tick could start another 10-scan agent until the 2 GB service was
# overloaded. The blocking gateway curl lives for exactly as long as its agent
# request, so its PID is the local source of truth for worker concurrency.
mkdir -p "$PIDDIR"
ACTIVE=0
for PF in "$PIDDIR"/*.pid; do
  [ -e "$PF" ] || continue
  PID=$(cat "$PF" 2>/dev/null || true)
  case "$PID" in ''|*[!0-9]*) rm -f "$PF"; continue ;; esac
  if kill -0 "$PID" 2>/dev/null; then
    ACTIVE=$((ACTIVE + 1))
  else
    rm -f "$PF"
  fi
done
AVAILABLE=$((MAXW - ACTIVE))
[ "$AVAILABLE" -gt 0 ] || exit 0

# debounce: at most one wake ROUND per 3 minutes (agents may still be draining)
LOCK=${ECA_WATCHDOG_LOCK_FILE:-/tmp/payroll_watchdog.last}
NOW=$(date +%s); LAST=$(cat "$LOCK" 2>/dev/null || echo 0)
[ $((NOW - LAST)) -lt 180 ] && exit 0
echo "$NOW" > "$LOCK"

# Scale the wake to the backlog without exceeding the global worker cap.
WANT=$(( QUEUED < AVAILABLE ? QUEUED : AVAILABLE ))
STAMP=$(date +%Y%m%d%H%M%S)
for i in $(seq 1 "$WANT"); do
  SID="eca-payroll-$STAMP-w$i"
  # Session key must be UNIQUE PER WAKE (stamp+worker): same-key calls are one
  # serialized session (collapsed the pool, 07-04 test 1), and REUSED keys carry
  # conversation memory across wake rounds — an agent that just computed FE runs
  # answered a PT job from memory in 1s and posted FE worksheets on a trainer
  # run ($0 instead of $20,433; caught by evaluator flags, 07-04 test 3). Fresh
  # key every wake = no cross-round contamination. The matching single-* label
  # is also enforced server-side as one claim for this unique session, so the
  # safety boundary does not depend on the model following this prompt.
  cat > "$WAKE_DIR/payroll_wake_$i.json" <<JSON
{"model":"hermes-agent","messages":[{"role":"user","content":"Process exactly ONE ECA worker job, then exit. Load and follow the eca-payroll-parse-plan skill. Make one claim request with \"worker_label\": \"single-$STAMP-w$i\". This label is backend-enforced as one claim for this session. Never claim a second job, even when more work is queued. The queue includes parse_pt_agreement_v1 jobs for the NEW Portal Postdates tracker: fetch the live pdn-v1 contract before reading them, process every asset_id in the claimed job, include handwritten postdate rows beyond the five printed rows, and never mix this with the legacy postdates system or PT comp plans. Complete, fail, or release the one job only through its documented endpoint, then stop so the next job receives a fresh session."}]}
JSON
  nohup curl -s --max-time 1800 -X POST "http://127.0.0.1:$PORT/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -H "X-Hermes-Session-Id: $SID" -H "X-Hermes-Session-Key: eca-payroll-$STAMP-w$i" \
    --data-binary "@$WAKE_DIR/payroll_wake_$i.json" >/dev/null 2>&1 &
  echo "$!" > "$PIDDIR/$SID.pid"
done
echo "payroll watchdog: $QUEUED job(s) queued -> woke $WANT agent(s) ($STAMP)"
