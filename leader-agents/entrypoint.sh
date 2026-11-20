#!/bin/sh
# Stage 0 (discovery): record how this Hermes release behaves, then keep a tiny
# web server up so the deploy is healthy and the report can be fetched.
# Replaced by the real supervisor once the facts are known.
set -u
PORT="${PORT:-10000}"
mkdir -p /tmp/www
echo "eca leader agents: discovery build" > /tmp/www/index.html
# Unguessable file name: the report is diagnostics from a throwaway container
# (tokens masked), but there is no reason to leave it at a guessable address.
NAME="d-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n').txt"
echo "[discover] report-file ${NAME}"
(
  sh /opt/eca/discover.sh > "/tmp/www/${NAME}.part" 2>&1
  mv "/tmp/www/${NAME}.part" "/tmp/www/${NAME}"
  echo "[discover] ===== DONE ${NAME} ====="
) &
exec python3 -m http.server "$PORT" --directory /tmp/www
