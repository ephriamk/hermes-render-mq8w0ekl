# syntax=docker/dockerfile:1.7
#
# ECA leader agents (trial): one full Hermes workspace per leader, each under
# its own Linux account, on ONE server. See the ECA vault note
# portal/eca-intelligence-layer-hermes-plan.md.
#
# Separate from the payroll/postdates worker image at the repo root: this one
# tracks a current Hermes release, because the browser workspace ("Webapp") and
# the Claude subscription plugin do not exist in the worker's pinned release.
ARG HERMES_IMAGE=docker.io/nousresearch/hermes-agent:v0.23.2@sha256:d6746a084e9341baada483e3d6210444d3c1aeb7c130f0915150065fb2851459
FROM ${HERMES_IMAGE}

USER root

# nginx fronts every leader's workspace (one public port on Render); the small
# supervisor behind it decides which leader a request belongs to.
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx-light openssl procps iproute2 curl ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/*

# Anthropic's own Claude Code program, unmodified. Each leader signs in to it
# themselves; the Hermes plugin only drives it.
# npm 12 blocks install scripts unless a package is named; Claude Code needs
# its own to fetch the native program.
ARG CLAUDE_CODE_VERSION=2.1.329
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && ln -sf "$(npm prefix -g)/bin/claude" /usr/local/bin/claude \
 && claude --version

COPY --chown=root:root . /opt/eca/
RUN chmod 0755 /opt/eca/*.sh

ENTRYPOINT ["/bin/sh", "/opt/eca/entrypoint.sh"]
CMD []
