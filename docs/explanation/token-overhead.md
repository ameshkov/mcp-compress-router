# About token overhead

This document explains the problem the router solves, what tool
definitions cost in a coding session, and how the router's two-tool
design removes that overhead. For the design of the code itself, see
[About the architecture](./architecture.md); for measured savings, see
[Benchmarks](../../bench/README.md).

## The problem

When several MCP servers are connected to a coding agent, every request
to the LLM includes all of their tool names, descriptions, and
parameter schemas. The [example tool listing](../assets/tools.json)
for three popular servers — Notion MCP, GitHub MCP, and Pylance MCP —
is about **26K tokens**, and the host sends it on every turn.

At Opus API pricing, over a 50-turn coding session, that overhead
costs:

- Input: `26K tokens * $5 / 1M = $0.13`
- Cache write (caching is not free):
  `26K tokens * $6.25 / 1M = $0.1625`
- Cache read (49 turns):
  `26K tokens * 49 * $0.50 / 1M = $0.637`

The total is about **$0.9275** for three MCP servers; more servers cost
more.

Not every host sends every definition on every request. Some defer MCP
definitions — Claude Code's MCP Tool Search does — and pay far less up
front; [Benchmarks](../../bench/README.md) shows what the router saves
in that case.

## The solution

Instead of sending all tools and descriptions every time, the router
connects to every downstream server and exposes a single stdio MCP
server with just two tools:

- **`get_tool_schema(server, tools?)`** — retrieves the JSON parameter
  schema and the full description for one or more tools on a
  downstream server. Its own description carries the compact catalog:
  one bullet per server that advertises tools — name, tool count, and
  description — plus a closing list-mode hint.
- **`invoke_tool(server, tool, arguments)`** — forwards a tool call to
  the downstream server and returns the result.

The agent works through the catalog before every call:

1. It reads the compact catalog from the `get_tool_schema` description
   and identifies the server it needs from the server name, the
   human-written description, and the tool count.
2. It calls `get_tool_schema` with just the server name to list that
   server's tools and their argument signatures.
3. It calls `get_tool_schema` with the chosen tool name to learn the
   exact parameters.
4. It calls `invoke_tool` to execute the tool, validated against the
   cached schema.

The compact catalog for the same three servers is about 600 tokens
([example](../assets/tools-compressed.json)). Repeating the cost
exercise with it gives about **$0.0215** per session — roughly
**97.7% less**. The more MCP servers you connect, the more the router
saves.

## Why the catalog is minimal

The catalog is the only part of the router that the host sends on every
request, so it is rendered in its smallest useful form: one bullet per
server with tools — name, tool count, and description — plus an
indented status line when the server is degraded. Tool names, argument
signatures, and descriptions never appear in it — the model reads them
with `get_tool_schema` when it actually needs them.

This is a deliberate trade-off. Listing tool names or signatures in the
catalog would remove a round trip for the model, but it would also add
those tokens to every request of the session, whether or not the tools
are used. With several servers, the per-request cost dwarfs the one-off
`get_tool_schema` call, so the router always keeps the catalog compact
rather than trading catalog detail for per-request overhead.

Two escape hatches keep the model unblocked:

- `get_tool_schema` with just a server name lists that server's tools
  and their argument signatures.
- `get_tool_schema` with tool names returns the complete JSON schema
  and the full tool description.

For the exact catalog format, see
[Compact Catalog](../reference/configuration.md#compact-catalog) in the
configuration reference.
