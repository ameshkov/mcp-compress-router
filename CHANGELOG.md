# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [v1.4.0] - 2026-06-26

### Added

- Per-server `compressionLevel` config field controlling how a
  server's tools are listed in the `get_tool_schema` description.
  Supports `max`, `high` (default), `medium`, and `low` values.

## [v1.3.1] - 2026-06-25

### Added

- README now documents a step-by-step Figma MCP setup (create a Personal
  Access Token, register an OAuth client via Figma's REST API with a
  fixed-port `127.0.0.1` redirect URI, add the server, provide
  `oauth.clientId`/`clientSecret`/`scope`/`callbackPort`, run `login`).

### Changed

- The `get_tool_schema` and `invoke_tool` tool descriptions now state
  emphatically that `get_tool_schema` MUST be called first to retrieve a
  tool's parameters before calling `invoke_tool`, making the required
  two-step workflow clearer to the agent.
- README "Connecting Coding Agents" examples now name the server key
  `mcp-compress-router` (was `compress-router`) across all agents for
  consistency with the package name.

## [v1.3.0] - 2026-06-25

### Added

- `--version` (and `-V`) flag prints the installed package version and
  exits.

## [v1.2.0] - 2026-06-25

### Changed

- The `get_tool_schema` tool description now renders each connected
  server as a `## {name}` section with the server description followed
  by an `Available tools:` label and the comma-separated tool list,
  making the per-server tool inventory easier to scan. The redundant
  `Available MCP servers and their tools:` preamble was removed.
- The OAuth login redirect URI path is now
  `/mcp-compress-router/oauth-callback` (was `/callback`). The full
  loopback redirect URI remains `http://localhost:<port>/mcp-compress-router/oauth-callback`
  with an OS-assigned port. Register
  `http://localhost/mcp-compress-router/oauth-callback` (no port) with
  OAuth providers that require a pre-registered redirect URI.

### Added

- `login --port <number>` and `add --port <number>` pin the local OAuth
  callback server to an exact port, for providers that require a
  pre-registered redirect URI with a fixed port (e.g.
  `http://localhost:8765/mcp-compress-router/oauth-callback`). `add`
  persists the port as `oauth.callbackPort` in `mcp.json`; `login`'s
  `--port` is a one-run override (use `--port 0` to force an
  OS-assigned port). New `oauth.callbackPort` config field (integer
  1-65535, validated at load time).
- README now documents the OAuth redirect URL and a step-by-step GitHub
  MCP setup (create OAuth App, set callback URL, add the server, provide
  `oauth.clientId`/`clientSecret`/`scope`, run `login`).

### Fixed

- `tools <name>` CLI subcommand now collapses embedded newlines in tool
  descriptions (e.g. markdown content from remote servers) so the
  `Name` / `Description` / `Exposure` table layout stays aligned and
  one row is rendered per tool.
- OAuth is now correctly discovered for spec-compliant remote MCP servers
  (e.g. GitHub `api.githubcopilot.com/mcp`, Notion `mcp.notion.com/mcp`).
  `probeAuthRequirement` and the `login` flow now follow the MCP 2025-06-18
  two-step authorization discovery (RFC 9728 Protected Resource Metadata ->
  RFC 8414 Authorization Server Metadata), with an origin-root fallback for
  legacy servers. `login` also no longer requires Dynamic Client
  Registration when an `oauth.clientId` override is configured, enabling
  GitHub login with a pre-registered client ID.
- `add <name> <url>` now detects OAuth on servers that publish their
  Authorization Server only via RFC 9728 Protected Resource Metadata
  `authorization_servers` (e.g. Notion, whose AS metadata lives at the
  origin root rather than the path-qualified well-known URL). The
  auto-probe now reuses the spec-compliant two-step `discoverAuth` flow
  instead of a one-step AS-metadata lookup, so auto-login is triggered
  and `authRequirement` is cached as `'oauth'` at add time.

## [v1.1.0] - 2026-06-25

### Added

- Per-server enable/disable: optional `enabled` field on server entries.
  When `false`, the server is skipped entirely at startup (no spawn, no
  connection, no discovery) and rejected by `get_tool_schema` /
  `invoke_tool` without contacting the downstream. Absent means enabled
  (backward compatible). New `enable` and `disable` CLI subcommands
  toggle the field idempotently; `list` gains an `Enabled` column.
- Per-server tool selection: optional `allowedTools` and `disabledTools`
  glob-pattern fields (picomatch; `[]` exposes nothing, denylist wins on
  conflict). Filtered tools are hidden from the catalog and hard-rejected
  by `invoke_tool`. New `--enabled`/`--disabled` and repeatable
  `--allowed-tools`/`--disabled-tools` flags on `add` set these at
  creation time (patterns validated at write time). `list` gains a
  `Tools` column summarising the configured filter patterns (offline).
- `tools <name>` CLI subcommand that connects to a downstream server
  live (regardless of `enabled` state), lists every tool it advertises,
  and marks each `[exposed]` or `[filtered]` against the server's
  configured selection — the primary workflow for building accurate
  allowlists without starting the full router.
- `--description <text>` flag on the `add` subcommand to optionally set
  a human-readable server description for the compact tool catalog.
- Usage instructions to the README: quick start with `npx`,
  prerequisites, config file location, downstream server configuration,
  OAuth, custom headers, secrets via `${VAR}` expansion, and agent
  connection examples for opencode, Claude Code, Codex, and GitHub
  Copilot. Clarified where `credentials.json` is stored when overriding
  the config path with `-c`.

## [v1.0.2] - 2026-06-23

### Changed

- Merged the release workflow into `ci.yml`. Publishing to npm now
  runs as a `publish` job in CI that depends on the `check` (quality
  gates) job, gated to tag pushes only (`v*`). The standalone
  `release.yml` was removed.

## [v1.0.1] - 2026-06-23

### Changed

- Release workflow now publishes via npm Trusted Publishers (tokenless
  OIDC) instead of an `NPM_TOKEN` secret. The release job was bumped to
  Node.js 24 to satisfy the npm CLI 11.5.1+ requirement for Trusted
  Publishers (Node 22 bundles npm 10.x, which is too old). Provenance is
  generated automatically from the existing `id-token: write`
  permission.
- Minimum supported Node.js runtime raised from 22 to 24. Updated the
  `engines.node` constraint, CI workflow, `@types/node`, and all
  documentation accordingly.

## [v1.0.0] - 2026-06-23

### Added

- Initial release of the MCP Compress Router — a single-router MCP
  server that compresses all connected MCP servers into one, exposing
  just two tools (`get_tool_schema` and `invoke_tool`) to reduce token
  overhead by up to 99%.
- Management CLI (`add`, `remove`, `get`, `list`) for downstream server
  configuration stored in `mcp.json`.
- Support for stdio and HTTP downstream MCP server transports.
- JSONC configuration file support with `${VAR}` / `${VAR:-default}`
  environment variable expansion.
- OAuth credential storage and `login` / `logout` CLI commands for
  downstream servers requiring authorization.
- Compact catalog text renderer for tool listings.
- JSON Schema argument validation for `invoke_tool`.

[unreleased]: https://github.com/ameshkov/mcp-compress-router/compare/v1.4.0...HEAD
[v1.4.0]: https://github.com/ameshkov/mcp-compress-router/releases/tag/v1.4.0
[v1.3.1]: https://github.com/ameshkov/mcp-compress-router/releases/tag/v1.3.1
[v1.3.0]: https://github.com/ameshkov/mcp-compress-router/releases/tag/v1.3.0
[v1.2.0]: https://github.com/ameshkov/mcp-compress-router/releases/tag/v1.2.0
[v1.1.0]: https://github.com/ameshkov/mcp-compress-router/releases/tag/v1.1.0
[v1.0.2]: https://github.com/ameshkov/mcp-compress-router/releases/tag/v1.0.2
[v1.0.1]: https://github.com/ameshkov/mcp-compress-router/releases/tag/v1.0.1
[v1.0.0]: https://github.com/ameshkov/mcp-compress-router/releases/tag/v1.0.0
