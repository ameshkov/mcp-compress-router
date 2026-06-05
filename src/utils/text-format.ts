import type { CatalogServer } from './types.js';

/**
 * Renders the compact catalog as Markdown text suitable for inclusion
 * in the `get_tool_schema` tool description.
 *
 * Format:
 *   ## {server name}
 *   {description (optional)}
 *   {tool1}, {tool2}, ...
 *
 * @param servers - The catalog server entries.
 * @returns Compact catalog text.
 */
export function renderCompactCatalog(servers: CatalogServer[]): string {
  const lines: string[] = [];

  for (const server of servers) {
    lines.push(`## ${server.name}`);
    if (server.description) {
      lines.push(server.description);
    }
    lines.push(server.tools.map((t) => t.name).join(', '));
    lines.push(''); // blank line between servers
  }

  return lines.join('\n').trimEnd();
}
