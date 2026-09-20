# syntax=docker/dockerfile:1
#
# QA workspace image for mcp-compress-router.
#
# Stages:
# - `build`  compiles the router from the checked-out source.
# - `qa`     (default) full manual-testing workspace: the compiled
#            router, the QA tooling and the stdio mock MCP server
#            (`qa/`), dev dependencies, opencode, GitHub Copilot CLI,
#            Claude Code and Codex CLI as the coding agents, and the
#            headless `qa-browser` OAuth helper. It is meant to run under
#            `qa/docker-compose.yml` next to the mock LLM and the HTTP
#            mock MCP servers.
# - `router` minimal runtime image a coding agent can spawn as an MCP
#            server: production dependencies plus build/index.js only.
#
# Build (run from the repository root):
#   docker build -f qa/Dockerfile -t mcp-compress-router-qa .
#   docker build -f qa/Dockerfile --target router -t mcp-compress-router .
#
# The workspace bakes the repository, so rebuild it after source
# changes; see qa/README.md for how the manual test plans use it.

FROM node:24-bookworm-slim AS build

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN npm install -g pnpm@10.14.0

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.app.json tsconfig.test.json ./
COPY src ./src
COPY qa ./qa
RUN pnpm build

# Minimal runtime: what a coding agent spawns as an MCP server.
FROM node:24-bookworm-slim AS router

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN npm install -g pnpm@10.14.0

# `ps` backs the router's process-tree termination (killProcessTree)
# for wrapped stdio downstreams; it is absent from the slim base.
RUN apt-get update \
    && apt-get install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/build ./build

ENTRYPOINT ["node", "build/index.js"]

# Full QA workspace: compiled router + QA tooling + stdio mock + agent.
# Kept as the last stage so a plain `docker build` produces it.
FROM node:24-bookworm-slim AS qa

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN npm install -g pnpm@10.14.0

# opencode is the reference coding agent the plans drive. Pin the
# version so the workspace matches the plans and the host install.
# `--allow-scripts` lets opencode's postinstall link the platform
# binary (npm 11 blocks dependency lifecycle scripts by default).
RUN npm install -g --allow-scripts=opencode-ai opencode-ai@1.18.31

# GitHub Copilot CLI is the second coding agent. The plans run it in
# BYOK mode against the mock LLM (`COPILOT_PROVIDER_*` plus
# `COPILOT_OFFLINE=true`), so no GitHub account is needed. The package
# ships the platform binary as an optional dependency and has no
# lifecycle scripts.
RUN npm install -g @github/copilot@1.0.86

# Claude Code is the third coding agent. It speaks the Anthropic
# Messages API, and the plans run it headless against the mock LLM's
# Anthropic-compatible endpoint (`ANTHROPIC_BASE_URL` plus
# `ANTHROPIC_AUTH_TOKEN`) with a hermetic `CLAUDE_CONFIG_DIR`, so no
# Anthropic account is needed. The package downloads its native binary
# in a postinstall step.
RUN npm install -g @anthropic-ai/claude-code@2.1.278

# Codex CLI is the fourth coding agent. It speaks the OpenAI Responses
# API, and the plans run it headless against the mock LLM's
# Responses-compatible endpoint (a scratch `CODEX_HOME` holding a custom
# `wire_api = "responses"` provider plus the dummy `QA_MOCK_API_KEY`),
# so no OpenAI account is needed. The package ships the platform binary
# as an optional dependency and has no lifecycle scripts.
RUN npm install -g @openai/codex@0.155.1

# `ps` backs the router's process-tree termination (killProcessTree);
# the agent cleanup plans also verify leaks with `pgrep`. curl backs the
# headless `qa-browser` OAuth helper. ca-certificates is required by the
# Copilot CLI native binary even for plain-HTTP provider endpoints: its
# HTTP client refuses to start without a system CA bundle.
RUN apt-get update \
    && apt-get install -y --no-install-recommends procps curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app /app

# Headless OAuth login: the router launches this instead of a browser.
RUN install -m 0755 /app/qa/scripts/qa-browser /usr/local/bin/qa-browser
ENV MCP_COMPRESS_ROUTER_BROWSER=qa-browser

# Keep the container alive so `docker compose exec workspace bash` and
# one-off `docker run -i ... node build/index.js` sessions can be
# started freely.
CMD ["tail", "-f", "/dev/null"]
