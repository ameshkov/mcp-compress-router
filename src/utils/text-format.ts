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
 * - `max` — tool names only, comma-separated on a single line.
 * - `high` (default) — `toolName(arg1, arg2)`, one tool per line.
 * - `medium` — `toolName(arg1, arg2): first sentence...`, one tool per
 *   line (the snippet is omitted when the description is absent).
 * - `low` — `<tool>toolName(arg1, arg2): full description</tool>`,
 *   one tool per line (description omitted when absent).
 *
 * Argument names are extracted from each tool's `inputSchema.properties`
 * keys in definition order. When a server has no tools, only the header
 * (and optional description) is rendered.
 *
 * @param servers - The catalog server entries.
 * @returns Compact catalog text.
 */
export function renderCompactCatalog(servers: CatalogServer[]): string {
  return servers.map((server) => renderServerBlock(server)).join('\n\n');
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
  if (server.tools.length > 0) {
    lines.push('', 'Available tools:');
    if (server.compressionLevel === 'max') {
      lines.push(server.tools.map((tool) => tool.name).join(', '));
    } else {
      for (const tool of server.tools) {
        lines.push(renderToolLine(tool, server.compressionLevel));
      }
    }
  }
  return lines.join('\n');
}

/**
 * Renders a single tool line at the `high`, `medium`, or `low` level.
 *
 * @param tool - The tool descriptor.
 * @param level - The compression level (never `max`).
 * @returns The formatted tool line.
 */
function renderToolLine(tool: ToolDescriptor, level: CompressionLevel): string {
  const args = extractArgumentNames(tool.inputSchema);
  const signature = `${tool.name}(${args.join(', ')})`;
  if (level === 'low') {
    return tool.description
      ? `<tool>${signature}: ${tool.description}</tool>`
      : `<tool>${signature}</tool>`;
  }
  if (level === 'medium') {
    const snippet = truncateToFirstSentence(tool.description);
    return snippet ? `${signature}: ${snippet}` : signature;
  }
  return signature;
}
