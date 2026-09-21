# Development Guide

How to set up, run, and debug MCP Compress Router from a repository
clone. For end-user installation, see the [README](./README.md). For
the configuration and environment reference, see
[docs/reference/configuration.md](./docs/reference/configuration.md).
For the manual QA stack, see [qa/README.md](./qa/README.md), and for
publishing, see [docs/guides/releasing.md](./docs/guides/releasing.md).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Build](#build)
- [Run](#run)
    - [Management commands](#management-commands)
- [Debug](#debug)
    - [MCP Inspector](#mcp-inspector)
    - [Real coding agent](#real-coding-agent)
    - [Raw JSON-RPC](#raw-json-rpc)
    - [Expected behavior](#expected-behavior)
    - [Troubleshooting](#troubleshooting)
- [Checks before committing](#checks-before-committing)

## Prerequisites

- **Node.js 24 or later** (check with `node --version`).
- **pnpm 10 or later** (install with `corepack enable && corepack prepare
  pnpm@latest --activate`, then verify with `pnpm --version`).
- A terminal running from the **repository root** for all commands
  below.

## Setup

The router keeps all of its state — configuration, secrets, and OAuth
credentials — in a single *router home directory*. For development,
keep this directory outside the default platform location so your test
data cannot collide with a real installation, and point the router at
it with `MCP_COMPRESS_ROUTER_HOME`:

```bash
mkdir -p dev-home
cp mcp.example.jsonc dev-home/mcp.jsonc
cp .env.example dev-home/.env
```

`dev-home/` is gitignored, so it is safe for experiments that may
contain secrets. Edit `dev-home/mcp.jsonc` to choose downstream servers
and `dev-home/.env` to supply any secrets the config references via
`${VAR}`.

The simplest setup uses the bundled fixture server, which needs no
credentials. Replace the contents of `dev-home/mcp.jsonc` with:

```jsonc
{
  "mcpServers": {
    "fixture": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "test/fixture-server.ts"],
      "description": "Local fixture tools (echo, add, multi_block)"
    }
  }
}
```

Run the router from the repository root so the relative `test/...` path
resolves. The fixture exposes `echo`, `add`, `multi_block`,
`failing_tool`, `echo_env`, and `crash`.

## Build

```bash
pnpm install      # first time only, or after dependency changes
pnpm build
```

The compiled entry point is `build/index.js`; the build also makes it
executable. Invoke it with Node during development:

```bash
node build/index.js --help
```

Rebuild after every source change. MCP clients launch the compiled
file, not the TypeScript sources.

## Run

With no subcommand, the router starts the MCP server on stdio — this is
how a coding agent connects to it:

```bash
MCP_COMPRESS_ROUTER_HOME="$PWD/dev-home" node build/index.js
```

Add `-v` (or set `MCP_COMPRESS_ROUTER_VERBOSE=true`) for debug-level
logging to stderr. At startup the router loads the config, connects to
every downstream server, discovers and caches their tools, then exposes
only `get_tool_schema` and `invoke_tool` over stdio.

If a downstream server fails to start and no tool cache exists for it,
the router exits with a non-zero code and prints the reason to stderr.
If a cache exists from a prior successful run, it starts in degraded
mode: the server's tools appear with a status header, and `invoke_tool`
attempts self-recovery on first use.

### Management commands

The same `build/index.js` binary is the management CLI:

```bash
export MCP_COMPRESS_ROUTER_HOME="$PWD/dev-home"

node build/index.js list
node build/index.js get fixture
node build/index.js add fixture -- npx tsx test/fixture-server.ts
node build/index.js add my-http http://localhost:3100/mcp \
  --header "Authorization: Bearer ${MY_SERVER_TOKEN}"
node build/index.js remove fixture
node build/index.js login my-http
node build/index.js logout my-http
```

Run `node build/index.js --help` or `<subcommand> --help` for all
flags. The complete CLI reference is in
[docs/reference/configuration.md](./docs/reference/configuration.md#cli-flags).

## Debug

Three practical ways to exercise the running router by hand.

### MCP Inspector

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
is an official interactive client for MCP servers over stdio, and the
fastest way to call the router's tools by hand. Launch it against the
local build:

```bash
npx @modelcontextprotocol/inspector \
  -e MCP_COMPRESS_ROUTER_HOME="$PWD/dev-home" \
  node build/index.js
```

A web UI opens at `http://localhost:6274`. Use **List Tools** to
confirm the router exposes exactly `get_tool_schema` and `invoke_tool`,
then call them to inspect schemas and results — for example
`server = fixture` (lists the fixture's tools), `server = fixture`,
`tools = ["echo"]` (returns the `echo` schema), or `server = fixture`,
`tool = echo`, `arguments = {"message":"hello"}`.

For scriptable checks without a browser, use `--cli`:

```bash
npx @modelcontextprotocol/inspector --cli \
  -e MCP_COMPRESS_ROUTER_HOME="$PWD/dev-home" \
  node build/index.js --method tools/call \
  --tool-name invoke_tool \
  --tool-arg 'server=fixture' \
  --tool-arg 'tool=echo' \
  --tool-arg 'arguments={"message":"hello"}'
```

To pass the router's own `-c` flag, put `--` before the server command.

### Real coding agent

To debug the full experience — the LLM reading the compressed catalog
and deciding when to call the router tools — point your agent's MCP
configuration at `node` plus the absolute path to `build/index.js`,
and set `MCP_COMPRESS_ROUTER_HOME` to the dev home. See
[Connect your coding agent](./README.md#1-connect-your-coding-agent)
for the per-agent configuration format. Rebuild and restart the agent
after every source change.

### Raw JSON-RPC

For a minimal, dependency-free protocol check, speak MCP JSON-RPC
directly over the router's stdio. The E2E suite uses the same pattern
(see `test/e2e/client.ts`); a one-off example:

```bash
MCP_COMPRESS_ROUTER_HOME="$PWD/dev-home" node - <<'EOF'
import { spawn } from 'node:child_process';

const proc = spawn('node', ['build/index.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
proc.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  for (const line of buf.split('\n')) {
    if (!line) continue;
    try {
      console.log(JSON.parse(line));
    } catch {
      // ignore non-JSON lines
    }
  }
  buf = '';
});

const send = (msg) => proc.stdin.write(JSON.stringify(msg) + '\n');

// MCP handshake
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-03-26', capabilities: {},
  clientInfo: { name: 'manual', version: '0.0.0' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

// List the two router tools
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

setTimeout(() => proc.kill(), 1000);
EOF
```

This prints the raw JSON-RPC responses to your terminal.

### Expected behavior

- `tools/list` returns exactly two tools: `get_tool_schema` and
  `invoke_tool`.
- The `get_tool_schema` description lists each server, its description,
  and its available tool names.
- `get_tool_schema` called with only a server name returns that server's
  tool signatures and a hint to request the full schemas.
- `get_tool_schema` returns JSON parameter schemas for a valid server
  and tool list.
- `invoke_tool` runs the downstream tool and returns its result.
- An unknown server or tool returns a clear error listing the valid
  options, not a crash.

### Troubleshooting

- **`Cannot find module 'build/index.js'`** — run `pnpm build` first.
- **Router exits immediately with a config or discovery error** — a
  downstream server failed to start or connect. Re-run with `-v` to see
  which one and why, then check tokens in `dev-home/.env` and command
  paths in `dev-home/mcp.jsonc`.
- **`${VAR}` expansion throws "unset"** — the variable is missing from
  `dev-home/.env` and has no `${VAR:-default}` fallback.
- **Wrong config is loaded** — verify `MCP_COMPRESS_ROUTER_HOME` is set
  (or pass `-c <path>`). With neither set, the router uses the
  platform default: `%APPDATA%\mcp-compress-router\` on Windows,
  `~/Library/Application Support/mcp-compress-router/` on macOS, or
  `~/.local/share/mcp-compress-router/` on Linux.
- **Server shows "requires login"** — run `login <name>` and retry; the
  router self-recovers on the next `invoke_tool`.
- **Server shows "unavailable"** — the downstream server failed to
  connect. Check connectivity and configuration; restart the MCP server
  in your agent if it persists.

## Checks before committing

The Husky pre-commit hook runs the full CI gate automatically:
`pnpm check` (format, lint, typecheck, build, and tests). Run it
manually before opening a pull request. The individual commands are in
[AGENTS.md](./AGENTS.md#build-and-test-commands); use `pnpm format:fix`
and `pnpm lint:fix` to auto-fix issues.
