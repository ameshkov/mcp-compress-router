# Configuration Reference

This document is a complete reference for every configuration option
and environment variable supported by MCP Compress Router. For a
quick-start guide, see the
[README](../README.md).

## Table of Contents

- [How Configuration Works](#how-configuration-works)
- [Configuration File Location](#configuration-file-location)
- [The mcp.json / mcp.jsonc File](#the-mcpjson--mcpjsonc-file)
    - [Server Entry Fields](#server-entry-fields)
    - [Server Types](#server-types)
    - [Tool Selection](#tool-selection)
    - [Variable Expansion](#variable-expansion)
- [OAuth Configuration](#oauth-configuration)
- [Credential Storage](#credential-storage)
- [Tool Cache](#tool-cache)
- [Self-Recovery](#self-recovery)
- [Environment Variables](#environment-variables)
    - [.env Auto-Loading](#env-auto-loading)
    - [MCP_COMPRESS_ROUTER_HOME](#mcp_compress_router_home)
    - [MCP_COMPRESS_ROUTER_VERBOSE](#mcp_compress_router_verbose)
    - [MCP_COMPRESS_ROUTER_BROWSER](#mcp_compress_router_browser)
    - [MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS](#mcp_compress_router_login_timeout_ms)
- [CLI Flags](#cli-flags)
    - [add](#add-name-commandorurl-rest)
    - [disable](#disable-name)
    - [enable](#enable-name)
    - [remove](#remove-name)
    - [tools](#tools-name)
    - [get](#get-name)
    - [list](#list)
    - [login](#login-name)
    - [logout](#logout-name)
- [Global Options](#global-options)

## How Configuration Works

MCP Compress Router reads its configuration from a single JSON(C)
file (`mcp.json` or `mcp.jsonc`) that lists every downstream MCP server
to compress into the router. At startup the router:

1. Resolves the config file path (see
   [Configuration File Location](#configuration-file-location)).
2. Loads and validates each server entry, expanding `${VAR}` references
   in string fields. Before resolution, a `.env` file in the current
   working directory is loaded automatically (see
   [Environment Variables](#environment-variables)).
3. Probes each HTTP server for OAuth support and caches the result in
   `credentials.json` (see [Credential Storage](#credential-storage)).
4. Connects to every downstream server, discovers their tools, and
   builds a compact catalog. On success, tool schemas are cached to
   `tools-cache.json`. On failure with a warm cache, the server starts
   in degraded mode. On failure with no cache (first run), the router
   exits (fail-fast).
5. Exposes two tools (`get_tool_schema` and `invoke_tool`) on a stdio
   transport.

Configuration never appears in the tool catalog sent to the LLM. Only
the compressed list of server and tool names is exposed.

## Configuration File Location

The router resolves the path to the configuration file using the
following priority (the first match wins):

1. The `-c, --config <path>` flag passed to any command.
2. The `MCP_COMPRESS_ROUTER_HOME` environment variable (treated as a
   directory that contains the config file).
3. The default location, which is platform-specific:
    - **Windows:** `%APPDATA%\mcp-compress-router\`
      (`C:\Users\<user>\AppData\Roaming\mcp-compress-router\`)
    - **macOS:** `~/Library/Application Support/mcp-compress-router/`
    - **Linux:** `~/.local/share/mcp-compress-router/`

When resolving a **directory** (case 2 or 3), the router prefers
`mcp.jsonc` over `mcp.json` when both exist. If neither exists, it
defaults to `mcp.json` (created on first use).

```bash
# Override the config path explicitly
mcp-compress-router -c /path/to/mcp.jsonc

# Override the config directory via environment variable
MCP_COMPRESS_ROUTER_HOME=/opt/mcp mcp-compress-router
```

If the file does not exist when a management command runs, the
directory is created automatically and an empty `{ "mcpServers": {} }`
file is written.

> **`.env` co-location:** A `.env` file in the same directory is loaded
> automatically at startup. See [`.env` Auto-Loading](#env-auto-loading).

## The mcp.json / mcp.jsonc File

The configuration file uses JSON or **JSONC** (JSON with comments and
trailing commas). The top level is an object with a single `mcpServers`
key. Each key under `mcpServers` is the unique name of a downstream
server, mapped to its configuration:

```jsonc
{
  // Comments and trailing commas are allowed in .jsonc files
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

> **Note for `mcp.json` (plain JSON, no comments):** This format
> is still fully supported and is the file written by CLI management
> commands (`add`, `remove`). If you hand-edit a `mcp.jsonc` file,
> CLI commands will work with it but comments are not preserved on
> write (JSON serialisation).

Server names must be unique. A duplicate name causes an error at load
time.

### Server Entry Fields

| Field | Required | Applies To | Description |
| --- | --- | --- | --- |
| `type` | Yes | All | Transport type: `stdio`, `http`, or `streamable-http` |
| `command` | stdio | stdio | Executable to launch the MCP server process |
| `args` | No | stdio | Array of arguments passed to `command` |
| `env` | No | stdio | Map of environment variables for the child process |
| `url` | HTTP | http, streamable-http | Endpoint URL of the MCP server |
| `headers` | No | http, streamable-http | Map of HTTP headers sent with each request |
| `description` | No | All | Human-readable description shown in the tool catalog |
| `oauth` | No | http, streamable-http | OAuth client overrides (see [OAuth Configuration](#oauth-configuration)) |
| `enabled` | No | All | Boolean. `false` skips the server entirely at startup (no spawn, no connection, no discovery). Defaults to `true` when omitted, so omitting it keeps `mcp.json` clean and is fully backward compatible |
| `allowedTools` | No | All | Array of glob patterns matched against the server's bare tool names. When present, only matching tools are exposed; `[]` (empty array) means *no* tools are exposed. Patterns are compiled under picomatch (`*`, `?`, `{a,b}`, `[abc]`) with strict bracket handling |
| `disabledTools` | No | All | Array of glob patterns removing matching tools from whatever would otherwise be exposed. Takes precedence on conflict: a tool matching both lists is blocked. Same glob semantics as `allowedTools` |

All string values in the fields above support
[Variable Expansion](#variable-expansion).

### Server Types

- **`stdio`** — The router spawns a local child process and communicates
  over standard input/output. Requires `command`. Optional `args` and
  `env` are passed to the spawned process.
- **`http`** — The router connects to a remote MCP server over HTTP.
  Requires `url`. Optional `headers` are sent with every request. This
  is the type used by the `add` command when the value starts with
  `http://` or `https://`.
- **`streamable-http`** — Same requirements as `http`, but uses the
  streamable HTTP transport. Use this when the downstream server
  implements the streaming variant of the MCP protocol.

### Tool Selection

The `allowedTools` and `disabledTools` fields control which of a
server's advertised tools are exposed to the LLM. Both are optional
arrays of glob patterns matched against bare tool names with
[picomatch](https://github.com/micromatch/picomatch) (`*`, `?`,
`{a,b}`, `[abc]`; strict bracket handling).

The effective exposed set is computed once at catalog build time:

1. Start with every tool the server advertises.
2. If `allowedTools` is present, keep only tools matching at least one
   pattern. An empty array (`[]`) keeps *nothing* — useful for staging
   a server (connected, configured) while you build the list.
3. Remove any tool matching a `disabledTools` pattern. The denylist
   wins on conflict: a tool matching both lists is blocked.

Filtered tools are both hidden from the `get_tool_schema` catalog and
hard-rejected by `invoke_tool`, so an LLM that guesses a filtered name
still cannot reach the downstream server.

```jsonc
"dangerous": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@some/mcp-server"],
  // Expose only these two...
  "allowedTools": ["list_issues", "get_pull_request"],
  // ...and additionally block anything ending in _delete.
  "disabledTools": ["*_delete"]
}
```

A configured pattern (literal or glob) that matches no tool the server
actually advertises is *not* an error — the router logs a warning
(visible with `-v`) identifying the unmatched pattern and continues
startup. A malformed pattern (one picomatch rejects) is a hard error
at config load time, naming the offending server and pattern.

Inspect what a server actually exposes — including the
`[exposed]`/`[filtered]` decision per tool — with the
[`tools <name>`](#tools-name) command.

### Variable Expansion

Every string field in a server entry (including values nested inside
`env`, `headers`, and `oauth`) is expanded against the process
environment at load time. Two syntaxes are supported:

| Syntax | Behavior |
| --- | --- |
| `${VAR}` | Replaced with the value of `VAR`. Throws if `VAR` is unset. |
| `${VAR:-default}` | Replaced with the value of `VAR` when set and non-empty, otherwise with `default`. |

This lets you keep secrets out of `mcp.json` and read them from the
environment instead:

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@some/mcp-server"],
  "env": {
    "API_KEY": "${MY_API_KEY}",
    "NODE_ENV": "${NODE_ENV:-production}"
  }
}
```

Variable names must start with a letter or underscore and may contain
letters, digits, and underscores.

## OAuth Configuration

HTTP and streamable-http servers may require OAuth. By default the
router uses [Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591)
against the server's OAuth endpoints when you run `login <name>`.

When a downstream server does not support dynamic registration, or you
want to use a pre-registered client, provide an `oauth` block:

```json
"oauth": {
  "clientId": "${MY_CLIENT_ID}",
  "clientSecret": "${MY_CLIENT_SECRET}",
  "scope": "read write"
}
```

| Field | Required | Description |
| --- | --- | --- |
| `clientId` | Yes | Pre-registered OAuth client ID |
| `clientSecret` | No | Pre-registered OAuth client secret |
| `scope` | No | Space-delimited scope string requested during authorization |
| `callbackPort` | No | Fixed TCP port for the local OAuth callback server (integer 1-65535). When set, `login` binds the callback server to this exact port so the redirect URI is stable. Omit to let the OS assign a port. |

When `clientId` is present, dynamic client registration is skipped and
the static client information is used instead. `clientId`, `clientSecret`,
and `scope` support [Variable Expansion](#variable-expansion);
`callbackPort` does not (ports are not secrets).

The `login` command starts a temporary local HTTP server and uses a
loopback redirect URI (per RFC 8252):

```text
http://localhost:<port>/mcp-compress-router/oauth-callback
```

`<port>` is assigned by the OS at login time, so there is no fixed port
to register. When the provider requires a pre-registered redirect URI,
register the loopback form without a port:

```text
http://localhost/mcp-compress-router/oauth-callback
```

If the provider demands a redirect URI with an exact port, pin it with
the `--port` flag or the `oauth.callbackPort` field:

```bash
mcp-compress-router login my-http --port 8765
```

`--port` overrides `oauth.callbackPort` for a single run; pass `--port 0`
to force an OS-assigned port even when `oauth.callbackPort` is set.

Authenticate a configured server with the `login` command:

```bash
mcp-compress-router login my-http
```

Remove stored credentials with `logout <name>`.

## Credential Storage

OAuth tokens, client registration records, and cached auth-requirement
metadata are stored in a separate `credentials.json` file located in
the same directory as `mcp.json`. The router manages this file
automatically — you do not edit it by hand.

```json
{
  "my-server": {
    "clientRegistration": {
      "client_id": "..."
    },
    "authRequirement": "oauth",
    "checkedAt": "2026-06-22T12:00:00Z",
    "tokens": {
      "access_token": "...",
      "refresh_token": "...",
      "expires_in": 3600,
      "scope": "read write",
      "token_type": "Bearer"
    }
  },
  "public-api": {
    "authRequirement": "none",
    "checkedAt": "2026-06-22T12:00:01Z"
  }
}
```

- `authRequirement` — cached result of the OAuth metadata probe
  (`"oauth"`, `"none"`, or `"unknown"`). Set at router startup and on
  `add`.
- `checkedAt` — ISO-8601 timestamp of the last probe.
- An entry without `tokens` represents a server that was probed but
  never logged in (or was since logged out). `logout` strips tokens but
  preserves `authRequirement`, so the server still appears in `list`
  with its auth status.
- On Unix systems, `credentials.json` is created with `0600`
  permissions (owner read/write only).
- On Windows, file permissions cannot be restricted; the router logs a
  warning and stores the file in the same directory.
- When the last entry is removed entirely, the file is deleted.
- The `clientRegistration` field is omitted when OAuth overrides
  (`oauth.clientId`) are used.

Add `credentials.json` to your `.gitignore` to avoid committing tokens.

## Tool Cache

Discovered tool schemas are persisted in a separate `tools-cache.json`
file, stored in the same directory as `mcp.json` (alongside
`credentials.json`). The router manages this file automatically.

```json
{
  "figma": {
    "tools": [
      {
        "name": "get_file",
        "description": "Fetch a Figma file by key.",
        "inputSchema": {
          "type": "object",
          "properties": { "key": { "type": "string" } }
        }
      }
    ],
    "cachedAt": "2026-07-11T12:00:00.000Z"
  }
}
```

- Written after every successful tool discovery (startup, after
  `login`, after self-recovery).
- Read when a server fails to connect at startup. If a cache exists,
  the server enters degraded mode (cached tools + status header). If
  no cache exists, the router fails fast.
- No TTL or expiry in v1. The cache is purely informational; an
  `invoke_tool` on a degraded server attempts self-recovery
  regardless.
- Add `tools-cache.json` to your `.gitignore`.

## Self-Recovery

When a server is in degraded mode (`unauthorized` or `unavailable`),
the router automatically attempts to reconnect on the next
`invoke_tool` call:

1. **Re-reads credentials from disk** — if you ran
   `mcp-compress-router login <name>` in another terminal, the router
   picks up the new tokens automatically (no restart needed).
2. **Creates a fresh client and transport** — the old broken connection
   is discarded.
3. **Connects and discovers tools** — if successful, the catalog is
   updated with fresh tool schemas and the invocation proceeds.
4. **Cooldown** — if the reconnect fails, subsequent `invoke_tool`
   calls within 30 seconds return the cached error immediately without
   retrying. This prevents hammering a dead server.

Runtime failures on a healthy server (e.g. the HTTP server crashed
mid-session) trigger one reconnect + retry before returning a guided
error.

## Environment Variables

The router reads the following environment variables. Before any config
resolution, a `.env` file in the **configuration directory** is loaded
automatically (see [`.env` Auto-Loading](#env-auto-loading) below).
Existing environment variables in the shell take precedence over `.env`
values.

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_COMPRESS_ROUTER_HOME` | Platform-specific (see [Configuration File Location](#configuration-file-location)) | Directory containing the config file. Overridden by `-c, --config`. Within this directory, `mcp.jsonc` is preferred over `mcp.json` |
| `MCP_COMPRESS_ROUTER_VERBOSE` | unset | Set to `true` to enable debug-level logging to stderr. Same as `-v, --verbose` |
| `MCP_COMPRESS_ROUTER_BROWSER` | unset | Override the browser command used to open OAuth URLs. The authorization URL is appended as a single final argument; no shell is used |
| `MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS` | `120000` (120 s) | Time in milliseconds to wait for the OAuth callback during `login` |

### `.env` Auto-Loading

A `.env` file in the **configuration directory** (see
[Configuration File Location](#configuration-file-location)) is loaded
at startup. The configuration directory is determined by the same
priority as the config file: `MCP_COMPRESS_ROUTER_HOME` if set,
otherwise the platform-specific default (see
[Configuration File Location](#configuration-file-location)).

```bash
# <configuration directory>/.env
GITHUB_PERSONAL_TOKEN=ghp_abc123
MY_SERVER_TOKEN=secret-token
```

Variables in `.env` are expanded before `${VAR}` references in the
config file are resolved. Shell environment variables always take
precedence over values from `.env`.

When using a `--config <path>` flag, the `.env` file is still loaded
from the configuration directory (not beside the explicit config path).
To use a `.env` in a custom location, set `MCP_COMPRESS_ROUTER_HOME` to
point to the same directory.

### `MCP_COMPRESS_ROUTER_HOME`

Points to a directory that contains `mcp.json` (and `credentials.json`
after a login). Use this to relocate all router state, for example to a
project directory or an XDG-compliant path.

```bash
MCP_COMPRESS_ROUTER_HOME=/opt/mcp mcp-compress-router
```

### `MCP_COMPRESS_ROUTER_VERBOSE`

Enables debug-level structured logging to stderr. Accepts the literal
string `true`; any other value is ignored. Equivalent to the
`-v, --verbose` flag.

```bash
MCP_COMPRESS_ROUTER_VERBOSE=true mcp-compress-router
```

### `MCP_COMPRESS_ROUTER_BROWSER`

Overrides the command used to open the authorization URL during
`login`. Set it to the executable plus any preset arguments. The
authorization URL is appended as a single, final argument and no shell
is involved, so the value is safe to use in headless and CI
environments.

```bash
MCP_COMPRESS_ROUTER_BROWSER="node /path/to/headless-browser.js" \
  mcp-compress-router login my-http
```

When unset, the platform default is used: `open` on macOS, `start` on
Windows, and `xdg-open` on Linux.

### `MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS`

Time in milliseconds the `login` command waits for the OAuth callback
before failing. Must be a positive integer; invalid values fall back to
the default of 120 seconds.

```bash
MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS=300000 \
  mcp-compress-router login my-http
```

## CLI Flags

The router exposes a management CLI. Every subcommand accepts the
global `-c, --config <path>` option to override the config file path.

### `add <name> <commandOrUrl> [rest...]`

Registers a downstream MCP server.

| Flag | Description |
| --- | --- |
| `--transport <type>` | Transport type: `stdio` (default) or `http`. Ignored when `commandOrUrl` starts with `http://` or `https://`, which forces HTTP |
| `--header <header>` | HTTP header as `Key: Value`. Repeatable |
| `-e, --env <env>` | Environment variable as `KEY=value`. Repeatable (stdio only) |
| `--description <text>` | Optional server description exposed to the LLM via `get_tool_schema`, helping it pick the right server. Optional |
| `--enabled` | Mark the server as enabled. Writes no `enabled` field (the default). Mutually exclusive with `--disabled` |
| `--disabled` | Mark the server as disabled. Writes `"enabled": false`. Mutually exclusive with `--enabled` |
| `--allowed-tools <pattern>` | Glob pattern allowlisting tool names (picomatch). Repeatable; collected in order into `allowedTools`. Validated at write time |
| `--disabled-tools <pattern>` | Glob pattern denylisting tool names (picomatch). Repeatable; collected in order into `disabledTools`. Validated at write time |
| `-p, --port <number>` | Fixed local OAuth callback port (HTTP only). Written to `oauth.callbackPort` so subsequent `login` runs reuse it. Integer 1-65535 |

```bash
mcp-compress-router add my-tool -- npx -y @some/mcp-server
mcp-compress-router add my-http \
  --header "Authorization: Bearer mytoken" \
  http://localhost:3100/mcp
mcp-compress-router add my-tool --description "Custom tools for my workflow" \
  -- npx -y @some/mcp-server
# Add a server that starts disabled (turn it on later with enable)
mcp-compress-router add archive --disabled -- npx -y server-archive

# Add a server restricted to an allowlist at creation time
mcp-compress-router add github --allowed-tools list_issues \
  --allowed-tools get_pull_request -- npx -y server-github

# Add a server with a denylist glob
mcp-compress-router add fs --disabled-tools "delete_*" -- npx -y fs-server
```

### `disable <name>`

Sets `"enabled": false` on a server entry without removing any of its
configuration. A disabled server is skipped entirely at startup: no
process spawn, no network connection, no discovery, and it does not
appear in the `get_tool_schema` catalog. All config (command, env,
OAuth overrides, tool filters) is preserved so it can be turned back on
instantly with `enable <name>`.

```bash
mcp-compress-router disable github
```

### `enable <name>`

Removes the `enabled` field from a server (so it defaults to enabled)
on the next startup. All other fields are preserved. Pure config edit —
no probe, no login, no side effects.

```bash
mcp-compress-router enable archive
```

### `remove <name>`

Removes a server entry from `mcp.json`. Stored credentials are left
intact; use `logout <name>` to remove them.

### `tools <name>`

Connects to the named server *live* and lists every tool it
advertises, each marked `[exposed]` or `[filtered]` against the
server's configured `allowedTools`/`disabledTools`. This is the primary
workflow for building an accurate allowlist/denylist without starting
the full router or reading verbose logs.

The command probes the server regardless of its `enabled` state, since
inspecting a disabled server's tools is how you build its allowlist.
For HTTP servers, cached OAuth `authRequirement` is refreshed before
connecting and stored credentials / `oauth` overrides are reused.

```bash
mcp-compress-router tools github
```

Example output:

```text
Tools exposed by "github":

Name           Description                                       Exposure
list_issues    List GitHub issues                                [exposed]
get_pull_req   Get a pull request by number                      [exposed]
delete_repo    Delete a repository                               [filtered]
```

If the server advertises no tools, the command prints
`(server advertises no tools)`. If the server is not found,
unreachable, or missing required auth, the command exits non-zero
with a clear error and prints no partial tool list.

### `get <name>`

Prints the raw configuration for a single server.

### `list`

Prints a table of every configured server with its transport type,
command or URL, enable state, configured tool-filter summary, and auth
status. All columns are read entirely from local files (`mcp.json` and
`credentials.json`) — no network access.

```text
Configuration was loaded from /home/user/.config/mcp-compress-router/mcp.json

Name      Type  CommandOrUrl                                   Enabled Tools                  Auth
github    http  https://api.github.com/mcp                     yes      all                   requires login
filtered  stdio npx -y @modelcontextprotocol/server-github     yes      2 allowed (1 blocked) none
archive   stdio npx -y @modelcontextprotocol/server-archive   no       all                   none
```

The `Enabled` column shows `yes` unless `enabled` is explicitly `false`
(absent = enabled). The `Tools` column summarizes the *configured*
filter patterns only — not live tool counts:

| Value | Meaning |
| --- | --- |
| `all` | No `allowedTools` or `disabledTools` configured |
| `N allowed` | `allowedTools` present with `N` patterns |
| `all (M blocked)` | `disabledTools` present with `M` patterns |
| `N allowed (M blocked)` | Both lists present |

For live per-tool `[exposed]`/`[filtered]` marks, use
[`tools <name>`](#tools-name).

The `Auth` column values:

| Value | Meaning |
| --- | --- |
| `none` | stdio server (no auth possible) |
| `header` | HTTP server with a static `Authorization` header |
| `authenticated` | HTTP server advertising OAuth with stored tokens |
| `requires login` | HTTP server advertising OAuth without tokens |
| `public` | HTTP server that does not advertise OAuth |
| `unknown` | HTTP server whose OAuth support could not be determined |

### `login <name>`

Runs the OAuth authorization-code flow for an HTTP server and stores
the resulting tokens in `credentials.json`. After successful
authentication, also discovers the server's current tools and writes
them to `tools-cache.json` so the next router startup (or
self-recovery) has an up-to-date cache.

| Flag | Description |
| --- | --- |
| `-p, --port <number>` | Fixed local OAuth callback port. Overrides `oauth.callbackPort`; `0` forces an OS-assigned port. |

### `logout <name>`

Revokes (best-effort) and removes stored credentials for a server.

## Global Options

When run without a subcommand, the router starts the MCP server over
stdio.

| Flag | Description |
| --- | --- |
| `-c, --config <path>` | Path to `mcp.json` (overrides `MCP_COMPRESS_ROUTER_HOME` and the default) |
| `-v, --verbose` | Enable debug-level logging to stderr (same as `MCP_COMPRESS_ROUTER_VERBOSE=true`) |

```bash
mcp-compress-router -v -c ./mcp.json
```
