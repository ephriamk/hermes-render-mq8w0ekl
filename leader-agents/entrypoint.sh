#!/bin/sh
# Stage 0 (discovery): print how this Hermes release behaves, then keep a tiny
# web server up so the deploy is healthy and the output can be read from the
# service logs. Replaced by the real supervisor once the facts are known.
set -u
PORT="${PORT:-10000}"

(
  sh /opt/eca/discover.sh 2>&1 | sed -u 's/^/[discover] /'
  echo "[discover] ===== DONE ====="
) &

mkdir -p /tmp/www && echo "eca leader agents: discovery build" > /tmp/www/index.html
exec python3 -m http.server "$PORT" --directory /tmp/www
