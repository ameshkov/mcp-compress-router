import type { CatalogServer } from './types.js';

/**
 * Renders the compact catalog as Markdown text suitable for inclusion
 * in the `get_tool_schema` tool description.
 *
 * Format:
 *   ## {server name}
 *   {description (optional)}
 *
 *   Available tools:
 *   {tool1}, {tool2}, ...
 *
 * When a server has no tools, only the header (and optional
 * description) is rendered.
 *
 * @param servers - The catalog server entries.
 * @returns Compact catalog text.
 */
export function renderCompactCatalog(servers: CatalogServer[]): string {
  const blocks: string[] = [];

  for (const server of servers) {
    const lines: string[] = [`## ${server.name}`];
    if (server.description) {
      lines.push(server.description);
    }
    if (server.tools.length > 0) {
      lines.push('');
      lines.push('Available tools:');
      lines.push(server.tools.map((t) => t.name).join(', '));
    }
    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}
