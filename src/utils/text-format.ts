import type { CatalogServer, CompressionLevel, ToolDescriptor } from './types.js';
import { extractArgumentNames } from './argument-names.js';
import { truncateToFirstSentence } from './description-truncator.js';

/**
 * Renders the compact catalog as Markdown text suitable for inclusion
 * in the `get_tool_schema` tool description.
 *
 * Each server's tools are rendered according to that server's
 * `compressionLevel`:
 *
 * - `max` — tool count plus a `get_tool_schema` pointer; no tool names.
 * - `high` (default) — tool names only, comma-separated on a single line.
 * - `medium` — `toolName(arg1, arg2)`, one tool per line.
 * - `low` — `toolName(arg1, arg2): first sentence...`, one tool per
 *   line (the snippet is omitted when the description is absent).
 *
 * No level renders full tool descriptions; they are always available
 * from a `get_tool_schema` result. Argument names are extracted from
 * each tool's `inputSchema.properties` keys in definition order. When a
 * server has no tools, no listing is rendered at all.
 *
 * @param servers - The catalog server entries.
 * @returns Compact catalog text.
 */
export function renderCompactCatalog(servers: CatalogServer[]): string {
  return servers.map((server) => renderServerBlock(server)).join('\n\n');
}

/**
 * Renders the list-mode response for `get_tool_schema`: the server's
 * tool signatures plus a hint to request the full parameter schema.
 *
 * Unlike {@link renderCompactCatalog}, this always renders full
 * signatures (`toolName(arg1, arg2)`) regardless of the server's
 * compression level: the list is a dynamic tool result, not the static
 * catalog. The status header is included when the server is degraded so
 * the caller knows a cached listing may need authentication or
 * reconnection. A zero-tool server gets a dedicated message instead of
 * the pointless "call again" hint.
 *
 * @param server - The catalog server to render.
 * @returns The list response text.
 */
export function renderToolListResponse(server: CatalogServer): string {
  const statusHeader = renderStatusHeader(server);
  if (server.tools.length === 0) {
    const lines = [`Server "${server.name}" advertises no tools.`];
    if (statusHeader) {
      lines.push(statusHeader);
    }
    return lines.join('\n');
  }

  const lines = [`Tools provided by "${server.name}" (${server.tools.length}):`];
  if (statusHeader) {
    lines.push(statusHeader);
  }
  lines.push('', ...server.tools.map((tool) => renderToolSignature(tool)), '');
  lines.push(
    'Call get_tool_schema with a tool name to get its full description and parameter schema.',
  );
  return lines.join('\n');
}

/**
 * Renders a single server section: header, optional description, and
 * the tool listing formatted for that server's compression level.
 *
 * @param server - The catalog server to render.
 * @returns The server block text.
 */
function renderServerBlock(server: CatalogServer): string {
  const lines: string[] = [`## ${server.name}`];
  if (server.description) {
    lines.push(server.description);
  }
  const statusHeader = renderStatusHeader(server);
  if (statusHeader) {
    lines.push(statusHeader);
  }
  if (server.tools.length > 0) {
    lines.push('', ...renderToolListing(server));
  }
  return lines.join('\n');
}

/**
 * Renders the tool listing lines for one server according to its
 * compression level.
 *
 * @param server - The catalog server to render the tools of.
 * @returns The listing lines (callers guard against zero tools).
 */
function renderToolListing(server: CatalogServer): string[] {
  if (server.compressionLevel === 'max') {
    const count = server.tools.length;
    const noun = count === 1 ? 'tool' : 'tools';
    const pronoun = count === 1 ? 'it' : 'them';
    return [
      `Provides ${count} ${noun}. Call get_tool_schema with "${server.name}" to list ${pronoun}.`,
    ];
  }
  const lines = ['Available tools:'];
  if (server.compressionLevel === 'high') {
    lines.push(server.tools.map((tool) => tool.name).join(', '));
  } else {
    for (const tool of server.tools) {
      lines.push(renderToolLine(tool, server.compressionLevel));
    }
  }
  return lines;
}

/**
 * Renders a one-line status header for degraded servers. Returns an
 * empty string for healthy ('ok') servers.
 *
 * @param server - The catalog server to render a status header for.
 * @returns A status line, or empty string when the server is healthy.
 */
function renderStatusHeader(server: CatalogServer): string {
  if (server.status === 'unauthorized') {
    return `Requires authentication. Run: npx mcp-compress-router login ${server.name}`;
  }
  if (server.status === 'unavailable') {
    return 'Server unavailable. Check connectivity and configuration.';
  }
  return '';
}

/**
 * Renders a tool's argument signature: `toolName(arg1, arg2)`.
 *
 * Argument names come from the tool's `inputSchema.properties` keys in
 * definition order; a tool without properties renders as `toolName()`.
 *
 * @internal Exported for tests only; not part of the public module API.
 *   Not re-exported from the barrel — production code calls it through
 *   {@link renderToolLine} and {@link renderToolListResponse}.
 *
 * @param tool - The tool descriptor.
 * @returns The tool signature.
 */
export function renderToolSignature(tool: ToolDescriptor): string {
  const args = extractArgumentNames(tool.inputSchema);
  return `${tool.name}(${args.join(', ')})`;
}

/**
 * Renders a single tool line at the `medium` or `low` level.
 *
 * `medium` renders the bare signature; `low` appends the first sentence
 * of the tool description when one is present.
 *
 * @param tool - The tool descriptor.
 * @param level - The compression level (never `max` or `high`).
 * @returns The formatted tool line.
 */
function renderToolLine(tool: ToolDescriptor, level: CompressionLevel): string {
  const signature = renderToolSignature(tool);
  if (level === 'low') {
    const snippet = truncateToFirstSentence(tool.description);
    return snippet ? `${signature}: ${snippet}` : signature;
  }
  return signature;
}
