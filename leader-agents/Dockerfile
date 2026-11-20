# ECA leader agents: one Hermes workspace per leader, each under its own Linux
# account, behind one front gate. Separate from the payroll worker image at the
# repo root. Plan: ECAMain/portal/eca-intelligence-layer-hermes-plan.md
ARG HERMES_IMAGE=docker.io/nousresearch/hermes-agent:v0.23.2@sha256:d6746a084e9341baada483e3d6210444d3c1aeb7c130f0915150065fb2851459
FROM ${HERMES_IMAGE}

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx-light socat dumb-init openssl procps iproute2 curl ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/*

# The unmodified Claude Code program. Each leader signs in to it themselves,
# inside their own workspace. npm 12 blocks install scripts unless a package is
# named; Claude Code needs its own to fetch the native program.
ARG CLAUDE_CODE_VERSION=2.1.329
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && ln -sf "$(npm prefix -g)/bin/claude" /usr/local/bin/claude \
 && claude --version

COPY --chown=root:root . /opt/eca/
RUN chmod 0755 /opt/eca/*.sh /opt/eca/supervisor.py \
 && chmod -R a+rX /opt/eca/skin \
 && /opt/hermes/.venv/bin/python -m py_compile /opt/eca/supervisor.py \
 && sed 's/__PORT__/10000/' /opt/eca/nginx.conf.template > /tmp/nginx-check.conf \
 && nginx -t -c /tmp/nginx-check.conf \
 && rm -f /tmp/nginx-check.conf

# A plain init that reaps the processes the workspaces leave behind. (The
# image's own /usr/bin/tini is a shim for Hermes's s6 start-up, which sets up
# the stock single-user home and drops root; neither is wanted here.)
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/bin/sh", "/opt/eca/entrypoint.sh"]
CMD []
