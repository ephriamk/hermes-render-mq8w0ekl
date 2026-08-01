#!/usr/bin/env bash
# Zero-token ECA queue watchdog (cron --no-agent). v3: postdates-aware.
# Every tick: one cheap HTTP check of the backend queue. Wake one Hermes agent
# only when work exists. The Render service has 2 GB RAM, so the safe default
# is deliberately one worker; ECA_MAX_PAYROLL_WORKERS can opt into more later.
# Each wake gets a distinct session and worker_label. Empty stdout = silent.
set -u
ENVF=/opt/data/.env
API=$(grep '^ECA_API_BASE_URL=' "$ENVF" | cut -d= -f2-); API=${API:-https://ecacombined-1.onrender.com}
KEY=$(grep '^API_SERVER_KEY=' "$ENVF" | cut -d= -f2-)
PORT=$(grep '^API_SERVER_PORT=' "$ENVF" | cut -d= -f2-); PORT=${PORT:-8788}
MAXW=$(grep '^ECA_MAX_PAYROLL_WORKERS=' "$ENVF" | cut -d= -f2-); MAXW=${MAXW:-1}
TOK=$(grep '^ECA_HERMES_SERVICE_TOKEN=' "$ENVF" | cut -d= -f2-)

# NOTE: /api/v4 is auth-gated (2026-07-01) — an unauthenticated check gets 401,
# parses as queued=0, and the watchdog never wakes (this silently killed the
# cloud worker for 3 days). The bearer header is load-bearing.
QUEUED=$(curl -s --max-time 12 -H "Authorization: Bearer $TOK" "$API/api/v4/agent/status" \
  | python3 -c "import sys,json; print(int((json.load(sys.stdin).get('queue') or {}).get('queued',0)))" 2>/dev/null || echo 0)
[ "$QUEUED" -gt 0 ] || exit 0

# debounce: at most one wake ROUND per 3 minutes (agents may still be draining)
LOCK=/tmp/payroll_watchdog.last
NOW=$(date +%s); LAST=$(cat "$LOCK" 2>/dev/null || echo 0)
[ $((NOW - LAST)) -lt 180 ] && exit 0
echo "$NOW" > "$LOCK"

# scale the wake to the backlog: 1 job -> 1 agent, 5 jobs -> MAXW agents.
WANT=$(( QUEUED < MAXW ? QUEUED : MAXW ))
STAMP=$(date +%Y%m%d%H%M%S)
for i in $(seq 1 "$WANT"); do
  SID="eca-payroll-$STAMP-w$i"
  # Session key must be UNIQUE PER WAKE (stamp+worker): same-key calls are one
  # serialized session (collapsed the pool, 07-04 test 1), and REUSED keys carry
  # conversation memory across wake rounds — an agent that just computed FE runs
  # answered a PT job from memory in 1s and posted FE worksheets on a trainer
  # run ($0 instead of $20,433; caught by evaluator flags, 07-04 test 3). Fresh
  # key every wake = no cross-round contamination.
  cat > "/tmp/payroll_wake_$i.json" <<JSON
{"model":"hermes-agent","messages":[{"role":"user","content":"Process the ECA worker queue now. Load and follow the eca-payroll-parse-plan skill. Claim jobs one at a time from the backend hermes_jobs queue — include \"worker_label\": \"cloud-w$i\" in every claim request body. The queue includes parse_pt_agreement_v1 jobs for the NEW Portal Postdates tracker: fetch the live pdn-v1 contract before reading them, process every asset_id, include handwritten postdate rows beyond the five printed rows, and never mix this with the legacy postdates system or PT comp plans. Process each job end-to-end, complete or fail only through the documented endpoints, and stop when the eligible queue is empty."}]}
JSON
  nohup curl -s --max-time 1800 -X POST "http://127.0.0.1:$PORT/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -H "X-Hermes-Session-Id: $SID" -H "X-Hermes-Session-Key: eca-payroll-$STAMP-w$i" \
    --data-binary "@/tmp/payroll_wake_$i.json" >/dev/null 2>&1 &
done
echo "payroll watchdog: $QUEUED job(s) queued -> woke $WANT agent(s) ($STAMP)"
