# Shared by every route that reaches a leader's workspace.
auth_request /_auth;
auth_request_set $agent_slug $upstream_http_x_agent_slug;
auth_request_set $agent_port $upstream_http_x_agent_port;
error_page 401 = /_eca/gate;

proxy_http_version 1.1;
# The workspace is served as if to a browser on the same machine.
proxy_set_header Host 127.0.0.1:$agent_port;
proxy_set_header Origin $eca_origin;
proxy_set_header Referer $eca_referer;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
# The gate's own cookie stays at the gate: a workspace never sees it, and a
# workspace cannot set cookies on the address every leader shares.
proxy_set_header Cookie "";
proxy_hide_header Set-Cookie;
# Nothing about the outer hops is passed on.
proxy_set_header X-Forwarded-For "";
proxy_set_header X-Forwarded-Host "";
proxy_set_header X-Forwarded-Proto "";
proxy_set_header X-Forwarded-Port "";
proxy_set_header X-Forwarded-Prefix "";
proxy_set_header X-Real-IP "";
proxy_set_header Forwarded "";
proxy_set_header True-Client-IP "";
proxy_set_header CF-Connecting-IP "";
proxy_set_header CF-Visitor "";

proxy_buffering off;
proxy_request_buffering off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
