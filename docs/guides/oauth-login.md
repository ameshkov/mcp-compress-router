# Authenticate with OAuth

HTTP and streamable-http MCP servers that require OAuth are supported.
This guide covers the generic login flow, redirect URLs, and headless
setups. For servers that need a pre-registered client, see
[Connect the GitHub MCP server](./oauth-github.md) and
[Connect the Figma MCP server](./oauth-figma.md).

## Log in to a server

When you `add` an HTTP server, the router probes it for OAuth metadata
and starts the login flow automatically if OAuth is advertised. You
can also trigger it manually:

```bash
npx mcp-compress-router@latest login my-http
```

This opens your browser to complete the authorization-code flow.
Tokens are stored in a separate `credentials.json` in the same
directory as `mcp.json` (with `0600` permissions on Unix), so you can
safely share or version-control `mcp.json` without exposing tokens.
Cached tool schemas are stored in `tools-cache.json` in the same
directory. Add both files to your `.gitignore`.

By default the router uses
[Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591).
If your server requires a pre-registered client, add an `oauth` block
to the server entry in `mcp.json`:

```jsonc
"my-http": {
  "type": "http",
  "url": "https://example.com/mcp",
  "description": "My HTTP MCP server",
  "oauth": {
    "clientId": "${MY_CLIENT_ID}",
    "clientSecret": "${MY_CLIENT_SECRET}",
    "scope": "read write"
  }
}
```

Only `clientId` is required; `clientSecret` and `scope` are optional.
See the
[OAuth configuration reference](../reference/configuration.md#oauth-configuration)
for every `oauth` field.

## Resource indicator

When the server publishes RFC 9728
[Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728),
the authorization and token requests carry the RFC 8707
[`resource`](https://datatracker.ietf.org/doc/html/rfc8707) indicator
that the metadata names, and proactive token refresh carries it too.
This binds the issued token to that specific MCP server, which
providers that enforce resource binding require. Servers that publish
no protected resource metadata are unaffected: the parameter is simply
omitted, matching the MCP SDK's behavior.

## Redirect URL

During `login` the router starts a temporary local HTTP server and uses
a loopback redirect URI (per
[RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252)):

```text
http://127.0.0.1:<port>/mcp-compress-router/oauth-callback
```

`<port>` is chosen by the OS at login time, so there is no fixed port
to register. Dynamic client registration registers the loopback form
**without a port**:

```text
http://127.0.0.1/mcp-compress-router/oauth-callback
```

RFC 8252 §8.4 excludes the port when a provider matches loopback
redirect URIs, so the registration stays valid across logins even though
the authorization request carries the ephemeral port. When a provider
requires a pre-registered redirect URI, register the same portless form.

Most providers (GitHub included) match the scheme, host, and path and
ignore the port on loopback addresses. If your provider demands a
redirect URI with an **exact port**, pin it with `--port`:

```bash
npx mcp-compress-router@latest login my-http --port 8765
```

This binds the callback server to `8765`, so the authorization request
uses `http://127.0.0.1:8765/mcp-compress-router/oauth-callback`. An
exact-port requirement applies to pre-registered clients: enter that
exact URL in the provider's console. Dynamic client registration always
registers the portless form above. To reuse the same port on every
`login`, persist it in the server's `oauth` block instead of passing
the flag each time:

```jsonc
"my-http": {
  "type": "http",
  "url": "https://example.com/mcp",
  "description": "My HTTP MCP server",
  "oauth": { "clientId": "${ID}", "callbackPort": 8765 }
}
```

`--port` overrides `oauth.callbackPort` for a single run. Pass
`--port 0` to force an OS-assigned port even when `oauth.callbackPort`
is set.

## Log out

```bash
npx mcp-compress-router@latest logout my-http
```

This removes the stored credentials for the server.

## Headless and CI environments

Override the browser with the `MCP_COMPRESS_ROUTER_BROWSER` environment
variable. The authorization URL is appended as a single final argument
(no shell):

```bash
MCP_COMPRESS_ROUTER_BROWSER="node /path/to/headless-browser.js" \
  npx mcp-compress-router@latest login my-http
```

The default login timeout is 120 seconds; override it with
`MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS`.
