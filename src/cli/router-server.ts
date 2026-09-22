import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createGetToolSchemaHandler, buildGetToolSchemaDescription } from '../tools/index.js';
import {
  createInvokeToolHandler,
  GetToolSchemaInputSchema,
  InvokeToolInputSchema,
} from '../tools/index.js';
import type { AsyncCleanup, ShutdownCoordinator } from '../services/index.js';
import type { ToolCatalog, Logger } from '../utils/index.js';
import { exceedsDynamicLimit } from '../utils/index.js';

/**
 * Signature of the downstream invocation function injected by the
 * entry point (mirrors {@link createInvokeToolHandler}'s parameter).
 */
export type InvokeDownstreamFn = (
  server: string,
  tool: string,
  args: Record<string, unknown>,
) => Promise<{ content: Array<Record<string, unknown>>; isError?: boolean }>;

/** Zod object for get_tool_schema arguments (validation + JSON schema). */
const getToolSchemaArgs = z.object(GetToolSchemaInputSchema);

/** Zod object for invoke_tool arguments (validation + JSON schema). */
const invokeToolArgs = z.object(InvokeToolInputSchema);

/** Whether a tools/list request is unblocked (catalog ready or shutdown). */
async function waitForCatalog(
  catalogReady: Promise<void>,
  coordinator: ShutdownCoordinator,
): Promise<void> {
  await Promise.race([
    catalogReady,
    coordinator.whenShutdownStarted().then(() => {
      throw new McpError(ErrorCode.ConnectionClosed, 'Router is shutting down');
    }),
  ]);
}

/**
 * Builds the router's two tool entries from the live catalog. Called per
 * `tools/list` request so the compact catalog (and the per-server status)
 * always reflects the latest discovery/reconnect state.
 *
 * When the client is known to truncate long tool descriptions (see
 * {@link exceedsDynamicLimit}) and the rendered `get_tool_schema`
 * description exceeds the configured cap, the whole catalog is
 * re-rendered at the `max` compression level. The forced render only
 * lowers compression levels, so a catalog that still exceeds the cap
 * afterwards (e.g. a long server description) is reported as a warning.
 *
 * @param catalog - The tool catalog (read live).
 * @param clientName - The MCP client name from `initialize`, if any.
 * @param logger - Structured logger (records auto-degradation).
 * @returns Tool entries for the MCP tools/list response.
 */
function buildRouterToolList(
  catalog: ToolCatalog,
  clientName: string | undefined,
  logger: Logger,
): Array<{ name: string; title: string; description: string; inputSchema: object }> {
  let getSchemaDescription = buildGetToolSchemaDescription(catalog);
  if (exceedsDynamicLimit(getSchemaDescription, clientName)) {
    logger.info('Auto-degrading catalog compression for length-limited client', {
      client: clientName,
      length: getSchemaDescription.length,
    });
    getSchemaDescription = buildGetToolSchemaDescription(catalog, { forceMax: true });
    if (exceedsDynamicLimit(getSchemaDescription, clientName)) {
      logger.warn('Catalog still exceeds the description cap after auto-degradation', {
        client: clientName,
        length: getSchemaDescription.length,
      });
    }
  }
  return [
    {
      name: 'get_tool_schema',
      title: 'Get Tool Schema',
      description: getSchemaDescription,
      inputSchema: z.toJSONSchema(getToolSchemaArgs),
    },
    {
      name: 'invoke_tool',
      title: 'Invoke Tool',
      description:
        'Invoke a specific tool on a connected MCP server. ' +
        'You MUST first use get_tool_schema to retrieve the required parameters ' +
        'for this tool before calling invoke_tool.',
      inputSchema: z.toJSONSchema(invokeToolArgs),
    },
  ];
}

/**
 * Validates tool arguments against the tool's Zod schema, mirroring the
 * SDK's McpServer behavior of rejecting malformed input with
 * `InvalidParams` (rather than passing garbage into the handlers).
 *
 * @param schema - The Zod object for the tool's arguments.
 * @param toolName - The tool name (for the error message).
 * @param args - The raw arguments from the tools/call request.
 * @returns The validated + trimmed arguments.
 * @throws McpError(InvalidParams) when the arguments do not match.
 */
function parseToolArguments<T extends z.ZodType>(
  schema: T,
  toolName: string,
  args: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid arguments for tool "${toolName}": ${detail}`,
    );
  }
  return parsed.data;
}

/**
 * Creates the router's MCP server (low-level SDK Server) and starts the
 * stdio transport IMMEDIATELY, before downstream servers have connected.
 * The host's `initialize` is answered right away; `tools/list` waits for
 * the catalog to be filled (bounded by the per-server connect timeouts,
 * aborted on shutdown) so the compact catalog always reflects the final
 * discovery state.
 *
 * Tool handlers receive only the catalog (plus the injected invocation
 * function) — never raw transport clients.
 *
 * @param catalog - The mutable tool catalog (empty at start).
 * @param invokeFn - Function forwarding tool calls to downstreams.
 * @param logger - Structured logger.
 * @param coordinator - Shutdown coordinator (aborts pending requests).
 * @param catalogReady - Resolves once the catalog has been populated.
 * @returns A cleanup function closing the router's MCP server.
 */
export async function startRouterServer(
  catalog: ToolCatalog,
  invokeFn: InvokeDownstreamFn,
  logger: Logger,
  coordinator: ShutdownCoordinator,
  catalogReady: Promise<void>,
): Promise<AsyncCleanup> {
  const server = new Server(
    { name: 'mcp-compress-router', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  const getToolSchemaHandler = createGetToolSchemaHandler(catalog, logger);
  const invokeToolHandler = createInvokeToolHandler(catalog, invokeFn, logger);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await waitForCatalog(catalogReady, coordinator);
    return {
      tools: buildRouterToolList(catalog, server.getClientVersion()?.name, logger),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Like tools/list, a direct tool call must wait for discovery to
    // publish the catalog (bounded by the per-server connect timeouts,
    // aborted on shutdown) so handlers never see an empty catalog.
    await waitForCatalog(catalogReady, coordinator);
    const { name, arguments: rawArgs } = request.params;
    switch (name) {
      case 'get_tool_schema':
        return getToolSchemaHandler(parseToolArguments(getToolSchemaArgs, name, rawArgs ?? {}));
      case 'invoke_tool':
        return invokeToolHandler(parseToolArguments(invokeToolArgs, name, rawArgs ?? {}));
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Server started on stdio');

  return async () => {
    try {
      await server.close();
    } catch {
      // Ignore close errors during shutdown — the process is exiting.
    }
  };
}
