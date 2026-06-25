# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `tools <name>` CLI subcommand now collapses embedded newlines in tool
  descriptions (e.g. markdown content from remote servers) so the
  `Name` / `Description` / `Exposure` table layout stays aligned and
  one row is rendered per tool.

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

[unreleased]: https://github.com/ameshkov/mcp-compress-router/compare/v1.1.0...HEAD
[v1.1.0]: https://github.com/ameshkov/mcp-compress-router/releases/tag/v1.1.0
[v1.0.2]: https://github.com/ameshkov/mcp-compress-router/releases/tag/v1.0.2
[v1.0.1]: https://github.com/ameshkov/mcp-compress-router/releases/tag/v1.0.1
[v1.0.0]: https://github.com/ameshkov/mcp-compress-router/releases/tag/v1.0.0
