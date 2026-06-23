# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[unreleased]: https://github.com/ameshkov/mcp-compress-router/compare/v1.0.0...HEAD
[v1.0.0]: https://github.com/ameshkov/mcp-compress-router/releases/tag/v1.0.0
