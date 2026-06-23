# Getting Started with MCP Compress Router

MCP Compress Router compresses all your MCP servers into a single router
MCP, saving up to 99% on token overhead. Instead of sending every tool
from every server to the LLM on every request, it exposes just two tools:
`get_tool_schema` and `invoke_tool`.

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
    - [The mcp.json Format](#the-mcpjson-format)
    - [Credential Storage](#credential-storage)
- [Adding MCP Servers](#adding-mcp-servers)
    - [Adding a stdio Server](#adding-a-stdio-server)
    - [Adding an HTTP Server](#adding-an-http-server)
    - [OAuth Login](#oauth-login)
- [Managing Servers](#managing-servers)
- [Connecting to Coding Agents](#connecting-to-coding-agents)
    - [Claude Desktop](#claude-desktop)
    - [VS Code with Copilot or Continue](#vs-code-with-copilot-or-continue)
    - [Cursor](#cursor)
    - [How It Works for the Agent](#how-it-works-for-the-agent)
- [Verbose Logging](#verbose-logging)
- [Next Steps](#next-steps)

## Installation

Install globally via npm:

```bash
npm install -g mcp-compress-router
```

Or with pnpm:

```bash
pnpm add -g mcp-compress-router
```

Requires **Node.js 22 or later**.

## Configuration

All configuration lives in a JSON(C) file. By default, the router
looks for a platform-specific location (preferring `mcp.jsonc` over
`mcp.json` when both exist):

- **Windows:** `%APPDATA%\mcp-compress-router\`
- **macOS:** `~/Library/Application Support/mcp-compress-router/`
- **Linux:** `~/.local/share/mcp-compress-router/`

You can override this path with:

- The `-c, --config` flag on any command, or
- The `MCP_COMPRESS_ROUTER_HOME` environment variable (points to a
  directory containing the config file).

Both `.json` and `.jsonc` formats are supported. JSONC allows
comments and trailing commas for hand-edited files. CLI management
commands (`add`, `remove`) write plain `.json`.

A `.env` file in the **configuration directory** is loaded automatically
at startup (see
[Configuration File Location](./configuration.md#configuration-file-location)),
so you can keep secrets out of your config and reference them via
[`${VAR}` syntax](./configuration.md#variable-expansion).

```jsonc
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_PERSONAL_TOKEN}"
      },
      "description": "GitHub API tools"
    },
    "my-server": {
      "type": "http",
      "url": "http://localhost:3100/mcp",
      "headers": {
        "Authorization": "Bearer ${MY_SERVER_TOKEN}"
      },
      "description": "My custom MCP server"
    }
  }
}
```

Each server entry supports these fields:

| Field | Required | Description |
| --- | --- | --- |
| `type` | Yes | Transport type: `stdio`, `http`, or `streamable-http` |
| `command` | For stdio | The command to launch the MCP server process |
| `args` | No | Arguments passed to the command |
| `env` | No | Environment variables for the server process |
| `url` | For HTTP | The HTTP endpoint of the MCP server |
| `headers` | No | HTTP headers to include in requests |
| `description` | No | A human-readable description of the server |
| `oauth` | No | OAuth overrides for HTTP servers (see below) |

All string fields support `${VAR}` and `${VAR:-default}` environment
variable expansion.

The optional `oauth` field (HTTP servers only) supplies a pre-registered
OAuth client instead of relying on dynamic client registration, and can
override the requested scope:

```json
"oauth": {
  "clientId": "${MY_CLIENT_ID}",
  "clientSecret": "${MY_CLIENT_SECRET}",
  "scope": "read write"
}
```

Only `clientId` is required within `oauth`; `clientSecret` and `scope`
are optional.

### Credential Storage

When you authenticate via OAuth, tokens are stored in a separate
`credentials.json` file in the same directory as `mcp.json`:

```json
{
  "my-server": {
    "tokens": {
      "access_token": "...",
      "refresh_token": "...",
      "expires_in": 3600,
      "token_type": "Bearer"
    }
  }
}
```

The file is created with restricted permissions (0600 — owner read/write
only) on Unix systems. You do not need to edit this file manually — it is
managed by the `login` and `logout` commands.

Keeping credentials in a separate file means you can safely share or
version-control `mcp.json` without exposing OAuth tokens. Add
`credentials.json` to your `.gitignore` to prevent accidental commits.

## Adding MCP Servers

Use the `add` command to register a downstream MCP server.

### Adding a stdio Server

```bash
# Basic usage
mcp-compress-router add my-tool -- npx -y @some/mcp-server

# With environment variables
mcp-compress-router add my-tool -e TOKEN=mytoken -- npx -y @some/mcp-server

# Custom config path
mcp-compress-router add -c /path/to/mcp.json my-tool -- node /path/to/server.js
```

### Adding an HTTP Server

> ![NOTE] If the URL starts with `http://` or `https://`, the transport
> is auto-detected as HTTP — the `--transport` flag is optional in that
> case.

```bash
mcp-compress-router add my-http --transport http http://localhost:3100/mcp

# With headers
mcp-compress-router add my-http \
  --transport http \
  --header "Authorization: Bearer mytoken" \
  http://localhost:3100/mcp
```

> ![NOTE] When you add an HTTP server, the router probes it for OAuth
> metadata. If the server advertises OAuth support, the `login` flow
> starts automatically so you can authenticate right away.

### OAuth Login

HTTP servers that require authentication via OAuth can be authorized
with:

```bash
mcp-compress-router login my-http
```

This is also triggered automatically by `add` when the server
advertises OAuth. To re-authenticate later (or if the automatic flow
was interrupted), run `login` again.

This opens your browser to complete the OAuth flow. The default timeout
is 120 seconds; you can increase it with the
`MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS` environment variable.

For headless environments or CI, override the browser command with the
`MCP_COMPRESS_ROUTER_BROWSER` environment variable. Set it to the
executable plus any arguments; the authorization URL is appended as a
single final argument, and no shell is used:

```bash
MCP_COMPRESS_ROUTER_BROWSER="node /path/to/headless-browser.js" \
  mcp-compress-router login my-http
```

To remove stored credentials:

```bash
mcp-compress-router logout my-http
```

## Managing Servers

```bash
# List all configured servers
mcp-compress-router list

# Show details for one server
mcp-compress-router get my-tool

# Remove a server
mcp-compress-router remove my-tool
```

## Connecting to Coding Agents

Once your downstream servers are configured, you connect the router the
same way you would connect any other MCP server — by pointing your
agent's MCP configuration at the `mcp-compress-router` command.

The examples below pass an explicit config path with `-c`. That
argument is optional — omit it to use the platform-specific default
(see [Configuration](#configuration)). The paths shown are Linux
examples; on macOS use
`~/Library/Application Support/mcp-compress-router/mcp.json`, and on
Windows use `%APPDATA%\mcp-compress-router\mcp.json`.

### Claude Desktop

Add this to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "compress-router": {
      "command": "mcp-compress-router",
      "args": [
        "-c",
        "/home/user/.local/share/mcp-compress-router/mcp.json"
      ]
    }
  }
}
```

### VS Code with Copilot or Continue

In your VS Code MCP configuration (`.vscode/mcp.json` or user-level
settings):

```json
{
  "servers": {
    "compress-router": {
      "command": "mcp-compress-router",
      "args": [
        "-c",
        "~/.local/share/mcp-compress-router/mcp.json"
      ]
    }
  }
}
```

### Cursor

Add to your Cursor MCP configuration:

```json
{
  "mcpServers": {
    "compress-router": {
      "command": "mcp-compress-router",
      "args": [
        "-c",
        "~/.local/share/mcp-compress-router/mcp.json"
      ]
    }
  }
}
```

### How It Works for the Agent

Once connected, the agent sees exactly **two tools**:

- **`get_tool_schema(server, tools)`** — Retrieves the JSON parameter
  schema for one or more tools on a downstream MCP server. The tool's
  description includes a compact listing of all servers and their
  available tool names.
- **`invoke_tool(server, tool, arguments)`** — Forwards a tool call to
  the downstream MCP server and returns the result.

The typical workflow:

1. The agent reads the compact catalog from the `get_tool_schema`
   description and identifies which tools it needs.
2. It calls `get_tool_schema` to learn the exact parameters.
3. It calls `invoke_tool` to execute a tool, validated against the
   cached schema.

This replaces thousands of tokens of tool listings with a compact ~900
token catalog, regardless of how many downstream servers you have.

## Verbose Logging

To debug connection or discovery issues, enable verbose logging:

```bash
mcp-compress-router -v
```

Or set the environment variable:

```bash
MCP_COMPRESS_ROUTER_VERBOSE=true mcp-compress-router
```

## Next Steps

- Add your first downstream server with `mcp-compress-router add`.
- Use `mcp-compress-router login <name>` for OAuth-protected HTTP
  servers.
- Point your coding agent at the router and enjoy a leaner, cheaper
  MCP experience.
