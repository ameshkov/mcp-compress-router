import type { ToolCatalog, Logger } from '../utils/index.js';
import { lookupTools } from '../services/index.js';
import { renderCompactCatalog } from '../utils/index.js';
import { z } from 'zod';

/**
 * Schema for get_tool_schema parameters.
 */
export const GetToolSchemaInputSchema = {
  server: z.string().describe('The name of the MCP server to query.'),
  tools: z.array(z.string()).min(1).max(50).describe('List of tool names to get the schema for.'),
};

/**
 * Creates the get_tool_schema handler closure over the catalog.
 *
 * @param catalog - The immutable tool catalog built at startup.
 * @param logger - Structured logger for diagnostic output.
 * @returns A handler function for the get_tool_schema MCP tool.
 */
export function createGetToolSchemaHandler(catalog: ToolCatalog, logger: Logger) {
  return async (params: { server: string; tools: string[] }) => {
    logger.info('get_tool_schema called', {
      server: params.server,
      tools: params.tools,
    });

    try {
      const schemas = lookupTools(catalog, params.server, params.tools);

      const result = schemas.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      }));

      logger.debug('get_tool_schema result', { result });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('get_tool_schema failed', {
        server: params.server,
        tools: params.tools,
        error: message,
      });
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}

/**
 * Builds the description string for get_tool_schema from the catalog.
 *
 * @param catalog - The tool catalog.
 * @returns A description string containing the compact catalog.
 */
export function buildGetToolSchemaDescription(catalog: ToolCatalog): string {
  const compact = renderCompactCatalog(catalog.servers);
  return 'Get the JSON schema for one or more tools from a connected MCP server.\n\n' + compact;
}
