#!/bin/sh
# Starts the supervisor and the front gate. If either stops, the container
# stops, so the host restarts it.
set -u
PORT="${PORT:-10000}"
mkdir -p /run/eca/diag /srv/eca
sed "s/__PORT__/${PORT}/" /opt/eca/nginx.conf.template > /run/eca/nginx.conf

/opt/hermes/.venv/bin/python -u /opt/eca/supervisor.py &
SUP=$!
i=0
while [ $i -lt 40 ]; do
  curl -s -o /dev/null -m 1 http://127.0.0.1:9000/_eca/health && break
  i=$((i+1)); sleep 0.5
done
nginx -c /run/eca/nginx.conf -g 'daemon off;' &
NGX=$!
echo "[entrypoint] supervisor pid $SUP, nginx pid $NGX, port $PORT"

if [ -f /opt/eca/discover.sh ]; then
  NAME="d-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n').txt"
  echo "[discover] report-file ${NAME}"
  ( sh /opt/eca/discover.sh > "/run/eca/diag/${NAME}.part" 2>&1; mv "/run/eca/diag/${NAME}.part" "/run/eca/diag/${NAME}"; echo "[discover] ===== DONE ${NAME} =====" ) &
fi

trap 'kill "$SUP" "$NGX" 2>/dev/null; exit 0' TERM INT
while kill -0 "$SUP" 2>/dev/null && kill -0 "$NGX" 2>/dev/null; do sleep 2; done
echo "[entrypoint] a core process stopped; exiting"
kill "$SUP" "$NGX" 2>/dev/null
exit 1
