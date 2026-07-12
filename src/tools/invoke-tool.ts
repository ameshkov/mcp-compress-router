import { z } from 'zod';
import type { ToolCatalog, Logger } from '../utils/index.js';
import { validateArguments } from '../utils/index.js';
import { lookupTools } from '../services/index.js';

/**
 * Signature of the downstream invocation function injected by the
 * entry point.
 */
type InvokeDownstreamFn = (
  server: string,
  tool: string,
  args: Record<string, unknown>,
) => Promise<{ content: Array<Record<string, unknown>>; isError?: boolean }>;

/**
 * Schema for invoke_tool parameters.
 */
export const InvokeToolInputSchema = {
  server: z.string().describe('The name of the MCP server that has the tool.'),
  tool: z.string().describe('The name of the tool to invoke.'),
  arguments: z.object({}).passthrough().describe('The arguments to pass to the tool.'),
};

/**
 * Validates invocation arguments against the tool's cached input
 * schema. Returns an error response when validation fails, or null
 * when arguments are valid.
 *
 * @param catalog - The immutable tool catalog.
 * @param server - The downstream server name.
 * @param tool - The tool name.
 * @param args - The arguments to validate.
 * @param logger - Structured logger for diagnostic output.
 * @returns A validation error response, or null when valid.
 */
function validateInvokeArgs(
  catalog: ToolCatalog,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  logger: Logger,
): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
  const descriptor = catalog.toolMap.get(`${server}::${tool}`);
  if (descriptor) {
    const validation = validateArguments(args, descriptor.inputSchema);
    if (!validation.valid) {
      logger.error('invoke_tool validation failed', {
        server,
        tool,
        errors: validation.errors,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Invalid arguments:\n${validation.errors.join('\n')}`,
          },
        ],
        isError: true as const,
      };
    }
  }
  return null;
}

/**
 * Creates the invoke_tool handler closure over the catalog and an
 * invoker function. The handler receives only the catalog and a
 * function — never raw transport clients.
 *
 * @param catalog - The immutable tool catalog built at startup.
 * @param invokeDownstream - Function to forward a tool call to the
 *   correct downstream server.
 * @param logger - Structured logger for diagnostic output.
 * @returns A handler function for the invoke_tool MCP tool.
 */
export function createInvokeToolHandler(
  catalog: ToolCatalog,
  invokeDownstream: InvokeDownstreamFn,
  logger: Logger,
) {
  return async (params: { server: string; tool: string; arguments: Record<string, unknown> }) => {
    logger.info('invoke_tool called', {
      server: params.server,
      tool: params.tool,
    });
    logger.debug('invoke_tool arguments', { arguments: params.arguments });

    try {
      // Validate server and tool exist in catalog
      lookupTools(catalog, params.server, [params.tool]);

      // Validate arguments against the cached input schema
      const validationError = validateInvokeArgs(
        catalog,
        params.server,
        params.tool,
        params.arguments,
        logger,
      );
      if (validationError) return validationError;

      const result = await invokeDownstream(params.server, params.tool, params.arguments);

      // Return content verbatim. The result type is looser than what
      // the MCP SDK expects, so we cast through unknown to satisfy
      // the handler signature while preserving the actual content
      // structure.
      return result as unknown as {
        content: Array<{ type: 'text'; text: string }>;
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('invoke_tool failed', {
        server: params.server,
        tool: params.tool,
        error: message,
      });
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true as const,
      };
    }
  };
}
