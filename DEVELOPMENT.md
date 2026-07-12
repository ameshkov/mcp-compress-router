# Development Guide

How to set up, run, and manually test MCP Compress Router on your own
machine. This guide assumes you are working inside a clone of the
repository. For installation as an end user, see the
[README](./README.md) instead.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Initial Setup](#initial-setup)
    - [1. Create a Router Home Directory](#1-create-a-router-home-directory)
    - [2. Copy the Example Files](#2-copy-the-example-files)
    - [3. Choose Your Downstream Servers](#3-choose-your-downstream-servers)
- [Building](#building)
- [Running the Router](#running-the-router)
- [Management Commands](#management-commands)
- [Manual Testing](#manual-testing)
    - [Choosing a Testing Approach](#choosing-a-testing-approach)
    - [Option 1: MCP Inspector (Recommended)](#option-1-mcp-inspector-recommended)
    - [Option 2: Connect a Real Coding Agent](#option-2-connect-a-real-coding-agent)
    - [Option 3: Raw JSON-RPC over stdio](#option-3-raw-json-rpc-over-stdio)
    - [What to Verify](#what-to-verify)
- [Code Quality Gates](#code-quality-gates)
- [Releasing](#releasing)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- **Node.js 24 or later** (check with `node --version`).
- **pnpm 10 or later** (install with `corepack enable && corepack prepare
  pnpm@latest --activate`, then verify with `pnpm --version`).
- A terminal running from the **repository root** for all commands below.

## Initial Setup

The router stores all of its state — configuration, secrets, and OAuth
credentials — in a single **router home directory**. For development we
keep this directory *outside* the default platform config location so
your test data does not collide with a real installation. We point the
router at it with the `MCP_COMPRESS_ROUTER_HOME` environment variable.

### 1. Create a Router Home Directory

From the repository root:

```bash
mkdir -p dev-home
```

`dev-home/` is gitignored (see `.gitignore`), so it is safe for local
experiments that may contain secrets. Everything the router writes (the
config file, `credentials.json`, `tools-cache.json`, a `.env` file)
will live here.

### 2. Copy the Example Files

Copy the bundled templates into your dev home and rename them so the
router picks them up:

```bash
cp mcp.example.jsonc dev-home/mcp.jsonc
cp .env.example dev-home/.env
```

- `dev-home/mcp.jsonc` — the list of downstream MCP servers to compress.
  JSONC means comments and trailing commas are allowed.
- `dev-home/.env` — secrets referenced from the config via `${VAR}`. The
  router auto-loads this file at startup.

Edit `dev-home/.env` and fill in any real values the config references
(for example `GITHUB_PERSONAL_TOKEN`).

> **Tip:** Secrets never need to live in `mcp.jsonc`. Use the
> [`${VAR}` / `${VAR:-default}` expansion](./docs/configuration.md#variable-expansion)
> and keep the actual values in `.env`.

### 3. Choose Your Downstream Servers

Edit `dev-home/mcp.jsonc` and replace the example entries with servers you
want to test against. You have two good options:

**Option A — Real servers (needs tokens).** Keep the GitHub/HTTP entries
from the template and supply working tokens in `dev-home/.env`. This gives
the most realistic test of compression and routing.

**Option B — The bundled fixture server (no tokens needed).** The repo
ships a tiny MCP server at `test/fixture-server.ts` that exposes `echo`,
`add`, `multi_block`, `failing_tool`, `echo_env`, and a `crash` tool. It
is perfect for local testing because it requires no credentials. Replace
the contents of `dev-home/mcp.jsonc` with:

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
resolves correctly.

You can also register servers with the CLI instead of hand-editing the
file — see [Management Commands](#management-commands).

## Building

Compile the TypeScript to `build/`:

```bash
pnpm install      # first time only, or after dependency changes
pnpm build
```

The compiled entry point is `build/index.js`. Run it with Node directly:

```bash
node build/index.js --help
```

There is no shebang in the source, so always invoke it through `node`
during development (the published `mcp-compress-router` command wraps it
with Node automatically).

To rebuild after editing source:

```bash
pnpm build
```

## Running the Router

With **no subcommand**, the router starts the MCP server on stdio (this is
how an agent connects to it). Point it at your dev home:

```bash
MCP_COMPRESS_ROUTER_HOME="$PWD/dev-home" node build/index.js
```

Add `-v` (or set `MCP_COMPRESS_ROUTER_VERBOSE=true`) for debug-level
logging to stderr, which shows configuration loading, tool discovery, and
every downstream invocation:

```bash
MCP_COMPRESS_ROUTER_HOME="$PWD/dev-home" node build/index.js -v
```

At startup the router:

1. Loads `.env` and `mcp.jsonc` from the home directory.
2. Connects to every downstream server, discovers their tools, and
   caches them to `tools-cache.json`.
3. Builds a compact catalog and exposes only `get_tool_schema` and
   `invoke_tool` over stdio.

If a downstream server fails to start and no tool cache exists for it
(first run), the router exits with a non-zero code and prints the
reason to stderr (fail-fast behavior). If a cache exists from a prior
successful run, the router starts in degraded mode — the server's
tools appear in the catalog with a status header, and `invoke_tool`
attempts self-recovery on first use.

## Management Commands

The same `build/index.js` binary is the management CLI. Run a subcommand to
inspect or change the configuration. The examples below all use
`MCP_COMPRESS_ROUTER_HOME`; you can equivalently pass `-c <path>` after the
subcommand name.

```bash
# Point all commands at the dev home for the rest of this shell:
export MCP_COMPRESS_ROUTER_HOME="$PWD/dev-home"

# List every configured server and its transport type
node build/index.js list

# Show the raw config for one server
node build/index.js get fixture

# Add a stdio server (everything after -- is the command + args)
node build/index.js add fixture -- npx tsx test/fixture-server.ts

# Add a stdio server with an environment variable
node build/index.js add my-tool -e API_KEY=secret -- npx -y @some/mcp-server

# Add an HTTP server (http(s):// URLs auto-select the http transport)
node build/index.js add my-http http://localhost:3100/mcp \
  --header "Authorization: Bearer ${MY_SERVER_TOKEN}"

# Remove a server (stored OAuth credentials are left in place)
node build/index.js remove fixture

# OAuth: authenticate / de-authenticate an HTTP server
node build/index.js login my-http
node build/index.js logout my-http
```

Run `node build/index.js --help` or `node build/index.js <subcommand> --help`
to see all flags.

## Manual Testing

There are three practical ways to exercise the running router by hand.
Pick based on what you want to validate.

### Choosing a Testing Approach

| Approach | Best for | Needs an LLM? |
| --- | --- | --- |
| [MCP Inspector](#option-1-mcp-inspector-recommended) | Driving the two router tools interactively, inspecting JSON schemas and responses | No |
| [Real coding agent](#option-2-connect-a-real-coding-agent) | End-to-end experience: the LLM deciding *when* to call the router tools | Yes |
| [Raw JSON-RPC](#option-3-raw-json-rpc-over-stdio) | Minimal, dependency-free protocol checks and scripting | No |

### Option 1: MCP Inspector (Recommended)

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) is
an official interactive tool for testing MCP servers over stdio. It is the
fastest way to call `get_tool_schema` and `invoke_tool` by hand and read
their JSON output. No coding agent required.

> Requires Node.js 24+. The inspector now prints a **session token** to the
> console and auto-opens the browser with it pre-filled, so you usually do
> not need to copy it manually.

#### UI mode

Launch the inspector pointing at the local build, passing the router home
as an environment variable (the `-e` flag forwards it to the spawned
server):

```bash
npx @modelcontextprotocol/inspector \
  -e MCP_COMPRESS_ROUTER_HOME="$PWD/dev-home" \
  node build/index.js
```

A web UI opens at `http://localhost:6274`. In it you can:

- Click **List Tools** — you should see exactly two: `get_tool_schema` and
  `invoke_tool`.
- Select `get_tool_schema` and fill in `server` and `tools` (for example
  `server = fixture`, `tools = ["echo"]`) to read a tool's JSON schema.
- Select `invoke_tool` and fill in `server`, `tool`, and `arguments` (for
  example `server = fixture`, `tool = echo`,
  `arguments = {"message":"hello"}`) to execute it and see the result.

To forward your router's `-c` flag instead, put `--` before the server
command to separate inspector flags from server arguments:

```bash
npx @modelcontextprotocol/inspector -- \
  node build/index.js -c "$PWD/dev-home/mcp.jsonc"
```

#### CLI mode

For quick, scriptable checks without a browser, use `--cli`. This is handy
for iterating during development.

```bash
# List the two tools the router exposes
npx @modelcontextprotocol/inspector --cli \
  -e MCP_COMPRESS_ROUTER_HOME="$PWD/dev-home" \
  node build/index.js --method tools/list

# Fetch the parameter schema for the fixture "echo" tool
npx @modelcontextprotocol/inspector --cli \
  -e MCP_COMPRESS_ROUTER_HOME="$PWD/dev-home" \
  node build/index.js --method tools/call \
  --tool-name get_tool_schema \
  --tool-arg 'server=fixture' \
  --tool-arg 'tools=["echo"]'

# Actually invoke a downstream tool through the router
npx @modelcontextprotocol/inspector --cli \
  -e MCP_COMPRESS_ROUTER_HOME="$PWD/dev-home" \
  node build/index.js --method tools/call \
  --tool-name invoke_tool \
  --tool-arg 'server=fixture' \
  --tool-arg 'tool=echo' \
  --tool-arg 'arguments={"message":"hello"}'
```

### Option 2: Connect a Real Coding Agent

To validate the full experience — where the LLM reads the compressed
catalog and decides for itself when to fetch a schema and invoke a tool —
point a real agent at your local build.

Add an entry to your agent's MCP configuration. Use `node` plus the
absolute path to `build/index.js`, and point `MCP_COMPRESS_ROUTER_HOME`
at the dev home directory:

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "compress-router": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-compress-router/build/index.js"
      ],
      "env": {
        "MCP_COMPRESS_ROUTER_HOME": "/absolute/path/to/mcp-compress-router/dev-home"
      }
    }
  }
}
```

**VS Code (Copilot)** — `.vscode/mcp.json` or user settings:

```json
{
  "servers": {
    "compress-router": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-compress-router/build/index.js"
      ],
      "env": {
        "MCP_COMPRESS_ROUTER_HOME": "/absolute/path/to/mcp-compress-router/dev-home"
      }
    }
  }
}
```

**OpenCode** — `opencode.json` (project) or
`~/.config/opencode/opencode.json` (global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "compress-router": {
      "type": "local",
      "command": [
        "node",
        "/absolute/path/to/mcp-compress-router/build/index.js"
      ],
      "environment": {
        "MCP_COMPRESS_ROUTER_HOME": "/absolute/path/to/mcp-compress-router/dev-home"
      }
    }
  }
}
```

Then restart the agent and try a prompt that needs a downstream tool, for
example (with the fixture configured): *"Use the echo tool to repeat the
text 'hello from the agent'."* Watch the agent call `get_tool_schema` first,
then `invoke_tool`. With `-v` enabled you can follow the same calls in the
router's stderr log.

> Remember to rebuild (`pnpm build`) after every source change before the
> agent picks it up.

### Option 3: Raw JSON-RPC over stdio

For a minimal, dependency-free check you can speak MCP JSON-RPC directly
over the router's stdio. The E2E test suite uses this exact pattern (see
`test/e2e/client.ts`). A one-off example:

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

### What to Verify

Whatever method you use, confirm these behaviors:

- `tools/list` returns exactly two tools: `get_tool_schema` and
  `invoke_tool`.
- The `get_tool_schema` description contains each server name, its
  description, and the list of available tool names.
- Calling `get_tool_schema` with a valid `server` and `tools` returns the
  JSON parameter schemas.
- Calling `invoke_tool` runs the downstream tool and returns its result.
- Asking for an unknown server or tool returns a clear error (with the
  list of valid options), not a crash.

## Code Quality Gates

Before proposing changes, run the full gate locally (this mirrors CI):

```bash
pnpm format:check   # Prettier + Markdownlint
pnpm lint           # ESLint + Knip unused-export analysis
pnpm typecheck      # TypeScript (production + test configs)
pnpm test           # Vitest unit + E2E suite
```

Convenience shortcuts:

- `pnpm format:fix` — auto-fix Prettier and Markdownlint issues.
- `pnpm lint:fix` — auto-fix ESLint issues.
- `pnpm check` — runs `format:check`, `lint`, `typecheck`, and `test` in
  sequence (the complete CI gate).
- `pnpm clean` — remove `node_modules` and `build/`.

The test suite includes E2E tests that spawn the compiled router as a
child process, so make sure you run `pnpm build` first if the E2E tests
fail to find `build/index.js`.

A Husky pre-commit hook is installed by `pnpm install` (see the `prepare`
script in `package.json`); it runs automatically when you commit.

## Releasing

Releases are published to the npm registry automatically by the
[Release workflow](.github/workflows/release.yml) whenever a version tag
is pushed.

### One-time setup

1. **npm access token.** Create an *Automation* (or fine-grained with
   publish permission) access token at
   [npmjs.com -> Access Tokens](https://www.npmjs.com/settings/ameshkov/tokens).
2. **Add the repository secret.** In
   `Settings -> Secrets and variables -> Actions -> New repository
   secret`, add a secret named `NPM_TOKEN` with the token from step 1.
3. The package is published as **public** (see `publishConfig` in
   `package.json`), so no first-time manual publish is required.

### Cutting a release

1. Make sure `CHANGELOG.md` is up to date under the `[Unreleased]`
   section.
2. Bump the `version` field in `package.json` following
   [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
3. Commit the version bump and tag it with a `v` prefix:

   ```bash
   git add package.json CHANGELOG.md
   git commit -m "Release v1.2.3"
   git tag v1.2.3
   git push origin master v1.2.3
   ```

The workflow verifies that the tag version matches `package.json`, runs
the full quality gate, builds, publishes to npm with provenance, and
creates a GitHub release linking to `CHANGELOG.md` with the npm tarball
attached.

### Notes

- The tag version **must** match `package.json` exactly, or the job
  fails fast.
- npm
  [provenance](https://docs.npmjs.com/generating-provenance-statements)
  is enabled, so each published version links back to its source
  commit and build.

## Troubleshooting

- **`Error: Cannot find module 'build/index.js'`** — run `pnpm build`
  first.
- **Router exits immediately with a config/discovery error** — a downstream
  server failed to start or connect. Re-run with `-v` to see which server
  and why. Confirm tokens in `dev-home/.env` and command paths in
  `dev-home/mcp.jsonc`.
- **`${VAR}` expansion throws "unset"** — the variable is not defined in
  `dev-home/.env` and has no `${VAR:-default}` fallback. Add it to `.env`
  or provide a default.
- **Wrong config is loaded** — verify `MCP_COMPRESS_ROUTER_HOME` is set
  (or pass `-c <path>`). When both are unset, the router falls back to
  the platform-specific default: `%APPDATA%\mcp-compress-router\`
  (Windows), `~/Library/Application Support/mcp-compress-router/`
  (macOS), or `~/.local/share/mcp-compress-router/` (Linux).
- **Inspector cannot reach the server** — run the inspector from the
  repository root and use an absolute path for the build, or rely on the
  working-directory-relative `node build/index.js`.
- **"Server shows 'requires login' in catalog"** — Run
  `mcp-compress-router login <name>`, then retry your request. The
  router self-recovers on the next `invoke_tool`.
- **"Server shows 'unavailable' in catalog"** — The downstream server
  failed to connect. Check connectivity and configuration. The router
  will attempt self-recovery on the next `invoke_tool`. If it persists,
  restart the MCP server in your coding agent.
