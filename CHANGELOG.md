# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `--description <text>` flag on the `add` subcommand to optionally set
  a human-readable server description for the compact tool catalog.
- Usage instructions to the README: quick start with `npx`,
  prerequisites, config file location, downstream server configuration,
  OAuth, custom headers, secrets via `${VAR}` expansion, and agent
  connection examples for opencode, Claude Code, Codex, and GitHub
  Copilot. Clarified where `credentials.json` is stored when overriding
  the config path with `-c`.

### Removed

- `docs/getting-started.md`. Its content is now covered by the README;
  cross-references in `configuration.md`, `DEVELOPMENT.md`, and
  `AGENTS.md` were updated to point to the README instead.

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

[unreleased]: https://github.com/ameshkov/mcp-compress-router/compare/v1.0.2...HEAD
[v1.0.2]: https://github.com/ameshkov/mcp-compress-router/releases/tag/v1.0.2
[v1.0.1]: https://github.com/ameshkov/mcp-compress-router/releases/tag/v1.0.1
[v1.0.0]: https://github.com/ameshkov/mcp-compress-router/releases/tag/v1.0.0
