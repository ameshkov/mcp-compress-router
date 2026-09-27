# syntax=docker/dockerfile:1
#
# Benchmark images for mcp-compress-router.
#
# Stages / build targets:
# - `build`    compiles the router from the checked-out source.
# - `router`   shared runtime base for every benchmark run: the compiled
#              router, production dependencies, `tsx`, the mock MCP stdio
#              servers and the benchmark harness, plus a pinned `ccusage`.
# - `claude`   router base + Claude Code.
# - `codex`    router base + Codex CLI.
# - `copilot`  router base + GitHub Copilot CLI.
# - `opencode` router base + OpenCode.
# - `opencode-v2` router base + OpenCode V2 (beta, default/last stage).
#
# Each agent image runs one isolated benchmark run per container:
#
#   docker build -f bench/Dockerfile --target claude -t mcp-compress-router-bench-claude .
#   docker run --rm -e BENCH_CLAUDE_API_KEY=... mcp-compress-router-bench-claude --mode router
#
# Normally you drive them through bench/docker-compose.yml instead; see
# bench/README.md. The workspace bakes the repository, so rebuild after
# source changes.

FROM node:24-bookworm-slim AS build

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN npm install -g pnpm@10.14.0

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.app.json tsconfig.test.json ./
COPY src ./src
COPY bench ./bench
RUN pnpm build

# Shared runtime base: what every benchmark container needs.
FROM node:24-bookworm-slim AS router

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# tsx runs the mock MCP servers and the benchmark harness; ccusage is
# the token-usage source of truth for the comparison.
RUN npm install -g pnpm@10.14.0 tsx@4.23.1 ccusage@20.0.24

# `ps` backs the router's process-tree termination (killProcessTree) for
# the wrapped stdio downstreams; ca-certificates is required by the
# agents' HTTPS clients.
RUN apt-get update \
    && apt-get install -y --no-install-recommends procps ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/build ./build
COPY bench ./bench

# Claude Code: driven headless with a hermetic CLAUDE_CONFIG_DIR; usage
# data is read back from that directory by `ccusage claude`.
FROM router AS claude

RUN npm install -g @anthropic-ai/claude-code@2.1.283

ENTRYPOINT ["tsx", "bench/scripts/run.ts", "--agent", "claude"]
CMD ["--mode", "direct"]

# Codex CLI: driven headless with a hermetic CODEX_HOME; session
# rollouts (kept, not ephemeral) are read back by `ccusage codex`.
FROM router AS codex

RUN npm install -g @openai/codex@0.156.1

ENTRYPOINT ["tsx", "bench/scripts/run.ts", "--agent", "codex"]
CMD ["--mode", "direct"]

# GitHub Copilot CLI: driven headless in BYOK mode with a hermetic
# COPILOT_HOME; the session events kept under it are read back by
# `ccusage copilot`.
FROM router AS copilot

RUN npm install -g @github/copilot@1.0.87

ENTRYPOINT ["tsx", "bench/scripts/run.ts", "--agent", "copilot"]
CMD ["--mode", "direct"]

# OpenCode: driven headless with a hermetic XDG config/data home; usage
# is read back by `ccusage opencode`. `--allow-scripts` lets opencode's
# postinstall link the platform binary (npm 11 blocks lifecycle scripts
# by default).
FROM router AS opencode

RUN npm install -g --allow-scripts=opencode-ai opencode-ai@1.18.32

ENTRYPOINT ["tsx", "bench/scripts/run.ts", "--agent", "opencode"]
CMD ["--mode", "direct"]

# OpenCode V2 (beta): the separate `@opencode/cli` package. V1 and V2 are
# not installed side by side, and V2 runs MCP servers through Code Mode
# by default, so the router's savings are expected to be smaller.
FROM router AS opencode-v2

RUN npm install -g --allow-scripts=@opencode/cli @opencode/cli@2.0.6

ENTRYPOINT ["tsx", "bench/scripts/run.ts", "--agent", "opencode-v2"]
CMD ["--mode", "direct"]
