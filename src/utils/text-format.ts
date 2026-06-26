import type { CatalogServer } from './types.js';
import { extractArgumentNames } from './argument-names.js';

/**
 * Renders the compact catalog as Markdown text suitable for inclusion
 * in the `get_tool_schema` tool description.
 *
 * At the `high` compression level (the default), each tool is rendered
 * on its own line as `toolName(arg1, arg2)`, with `toolName()` for
 * zero-parameter tools. Argument names are extracted from each tool's
 * `inputSchema.properties` keys in definition order.
 *
 * Format:
 *   ## {server name}
 *   {description (optional)}
 *
 *   Available tools:
 *   {tool1}(arg1, arg2)
 *   {tool2}()
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
      for (const tool of server.tools) {
        const args = extractArgumentNames(tool.inputSchema);
        lines.push(`${tool.name}(${args.join(', ')})`);
      }
    }
    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}
