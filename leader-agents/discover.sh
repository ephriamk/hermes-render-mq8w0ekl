#!/bin/sh
# Round 3: read-only facts about how the Webapp signs a browser in and how it
# is themed. Source of an open-source program and tool versions only; no
# accounts are created here and nothing secret is printed. Temporary.
set -u
sec() { echo; echo "===== $* ====="; }
dump() { echo; echo "##### FILE $1"; cat "$1" 2>/dev/null || echo "(missing)"; }

sec "tools"
nginx -V 2>&1 | tr ' ' '\n' | grep -E "sub_module|auth_request|realip" | head
socat -V 2>/dev/null | head -2
ls -la /usr/bin/python3* 2>/dev/null | head -4
ls /opt/hermes/tools/node-*/bin 2>/dev/null | head -20
head -c 300 /proc/net/tcp; echo
cat /proc/version 2>/dev/null | cut -c1-160

sec "webapp sign-in sources"
for f in gateway/webapp_listener.py hermes_cli/webapp_sign_in.py hermes_cli/web_routers/webapp.py \
         hermes_cli/web_server_boundary.py hermes_cli/webapp_page_policy.py hermes_cli/webapp_access.py; do
  dump "/opt/hermes/$f"
done
ls -la /opt/hermes/hermes_cli/dashboard_auth/ 2>/dev/null
dump /opt/hermes/hermes_cli/dashboard_auth/request_utils.py

sec "webapp bundle"
D=/opt/hermes/apps/desktop/dist-webapp
ls -la "$D" | head -40
echo "--- index.html"; cat "$D/index.html" 2>/dev/null | head -80
echo "--- assets"; ls -la "$D/assets" 2>/dev/null | awk '{print $5, $9}' | sort -rn | head -30
CSS="$(ls -S "$D"/assets/*.css 2>/dev/null | head -1)"
echo "--- css custom properties in $CSS"
grep -oE -- '--[a-zA-Z0-9-]+:' "$CSS" 2>/dev/null | sort | uniq -c | sort -rn | head -120
echo "--- theme hooks"
grep -oE '\[data-theme[^]]*\]|\.theme-[a-zA-Z0-9-]+|data-skin[^ ,{]*|:root\.[a-zA-Z0-9-]+|html\.[a-zA-Z0-9-]+' "$CSS" 2>/dev/null | sort | uniq -c | sort -rn | head -40
echo "--- DESIGN.md"; head -150 /opt/hermes/apps/desktop/DESIGN.md 2>/dev/null
echo "===== END ====="
