#!/usr/bin/env bash
# Dedicated zero-agent scheduler entrypoint for the new Portal Postdates
# tracker. One invocation runs at most one bounded PT-agreement job and never
# falls through to payroll or compensation-plan work.
set -u

PT_WORKER=${ECA_PT_WORKER_PATH:-/opt/data/scripts/pt_agreement_worker.py}
RUN_LOCK=${ECA_WATCHDOG_RUN_LOCK:-/tmp/eca_payroll_watchdog.lock}

exec 9>"$RUN_LOCK"
if ! flock -n 9; then
  exit 0
fi

if [ ! -x "$PT_WORKER" ]; then
  echo "postdates watchdog: direct PT worker is missing or not executable" >&2
  exit 1
fi

PT_OUTPUT=$($PT_WORKER 2>&1)
PT_RC=$?
case "$PT_RC" in
  0|75)
    exit 0
    ;;
  10|20|21)
    [ -z "$PT_OUTPUT" ] || printf '%s\n' "$PT_OUTPUT"
    exit 0
    ;;
  *)
    [ -z "$PT_OUTPUT" ] || printf '%s\n' "$PT_OUTPUT" >&2
    exit 1
    ;;
esac
