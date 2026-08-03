#!/bin/sh
# Entrypoint wrapper for the render-tools image.
#
# Runs as root (PID-1 child of tini). On every boot it:
#   1. Ensures /opt/data exists and is owned by hermes:hermes.
#   2. Runs the config patcher as the hermes user. The patcher is
#      idempotent: it only INSERTs the Render MCP server and the
#      skills.external_dirs entry; it never overwrites user edits.
#   3. Synchronizes the image-tested ECA worker skill and queue watchdog onto
#      the persistent disk paths Hermes actually loads.
#   4. Exec's the upstream entrypoint chain with the original args
#      (default CMD is `gateway run`).
#
# The upstream entrypoint also chowns /opt/data and drops to the hermes
# user via gosu for the gateway process. Our chown here is redundant in
# the happy path but harmless, and it lets the patcher run on a fresh
# disk that hasn't been chowned yet.

set -eu

DATA_DIR="${HERMES_HOME:-/opt/data}"
PATCHER="/opt/render-tools/patch-config.py"
WATCHDOG_SOURCE="/opt/render-tools/payroll_watchdog.sh"
POSTDATES_WATCHDOG_SOURCE="/opt/render-tools/postdates_watchdog.sh"
PT_WORKER_SOURCE="/opt/render-tools/pt_agreement_worker.py"
WATCHDOG_DIR="${DATA_DIR}/scripts"
WATCHDOG_TARGET="${WATCHDOG_DIR}/payroll_watchdog.sh"
POSTDATES_WATCHDOG_TARGET="${WATCHDOG_DIR}/postdates_watchdog.sh"
PT_WORKER_TARGET="${WATCHDOG_DIR}/pt_agreement_worker.py"
ECA_SKILL_SOURCE="/opt/render-tools/skills-local/eca-payroll-parse-plan"

# Make sure the data dir exists and the hermes user can write to it
# before we run the patcher. Idempotent — if /opt/data is already a
# mounted, chowned disk this is a no-op.
mkdir -p "${DATA_DIR}"
if ! chown -R hermes:hermes "${DATA_DIR}" 2>/dev/null; then
  echo "[render-tools] warning: could not chown ${DATA_DIR}; continuing" >&2
fi

# Patch config.yaml. We never fail the boot on a patch error — the agent
# can still run without the Render MCP server registered, and the user
# can always add it manually from the dashboard.
if [ -x "${PATCHER}" ]; then
  if ! gosu hermes "${PATCHER}" "${DATA_DIR}/config.yaml"; then
    echo "[render-tools] warning: config patch failed; continuing with unmodified config" >&2
  fi
else
  echo "[render-tools] warning: ${PATCHER} not found or not executable; skipping" >&2
fi

# Keep the cron script and the worker skill on the same image revision. The
# cron job already references payroll_watchdog.sh from this persistent folder.
if [ -f "${WATCHDOG_SOURCE}" ]; then
  install -d -o hermes -g hermes -m 0755 "${WATCHDOG_DIR}"
  install -o hermes -g hermes -m 0755 "${WATCHDOG_SOURCE}" "${WATCHDOG_TARGET}"
else
  echo "[render-tools] warning: ${WATCHDOG_SOURCE} not found; keeping existing watchdog" >&2
fi

if [ -f "${PT_WORKER_SOURCE}" ]; then
  install -d -o hermes -g hermes -m 0755 "${WATCHDOG_DIR}"
  install -o hermes -g hermes -m 0755 "${PT_WORKER_SOURCE}" "${PT_WORKER_TARGET}"
else
  echo "[render-tools] warning: ${PT_WORKER_SOURCE} not found; direct PT reader unavailable" >&2
fi

if [ -f "${POSTDATES_WATCHDOG_SOURCE}" ]; then
  install -d -o hermes -g hermes -m 0755 "${WATCHDOG_DIR}"
  install -o hermes -g hermes -m 0755 \
    "${POSTDATES_WATCHDOG_SOURCE}" "${POSTDATES_WATCHDOG_TARGET}"
else
  echo "[render-tools] warning: ${POSTDATES_WATCHDOG_SOURCE} not found; dedicated postdates cron unavailable" >&2
fi

# The existing deployment has persistent skill copies under both the global
# skill tree and the sheets-agent profile. They take precedence over image
# overlays, so update those copies in place without deleting unrelated files.
if [ -f "${ECA_SKILL_SOURCE}/SKILL.md" ]; then
  for skill_target in \
      "${DATA_DIR}/skills/business/eca-payroll-parse-plan" \
      "${DATA_DIR}/profiles/sheets-agent/skills/business/eca-payroll-parse-plan"
  do
    install -d -o hermes -g hermes -m 0755 "${skill_target}"
    cp -a "${ECA_SKILL_SOURCE}/." "${skill_target}/"
    chown -R hermes:hermes "${skill_target}"
  done
else
  echo "[render-tools] warning: ${ECA_SKILL_SOURCE} not found; keeping existing ECA skill" >&2
fi

# Hand off to the upstream entrypoint. The upstream script handles
# privilege drop, dashboard backgrounding, and the actual gateway exec.
exec /opt/hermes/docker/entrypoint.sh "$@"
