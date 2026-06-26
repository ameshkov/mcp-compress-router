import {
  resolveConfigPath,
  invokeDownstreamTool,
  OAuthCredentialManager,
  persistAuthRequirements,
  loadConfig,
  connectAndDiscover,
  buildCatalog,
} from '../services/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  CompressionLevel,
  DownstreamServerConfig,
  ToolCatalog,
  ToolSelection,
} from '../utils/index.js';
import { Logger } from '../utils/index.js';
import {
  createGetToolSchemaHandler,
  buildGetToolSchemaDescription,
  GetToolSchemaInputSchema,
  createInvokeToolHandler,
  InvokeToolInputSchema,
} from '../tools/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * Creates OAuth credential managers for HTTP servers that have stored
 * credentials or oauth overrides, so the transport can handle auth.
 */
async function buildAuthProviders(
  resolved: string,
  servers: DownstreamServerConfig[],
): Promise<Map<string, OAuthClientProvider>> {
  const authProviders = new Map<string, OAuthClientProvider>();
  for (const server of servers) {
    if (server.type === 'http' || server.type === 'streamable-http') {
      const mgr = new OAuthCredentialManager(resolved, server);
      const hasCredentials = (await mgr.tokens()) !== undefined;
      const hasOverrides = server.oauth?.clientId !== undefined;
      if (hasCredentials || hasOverrides) {
        authProviders.set(server.name, mgr);
      }
    }
  }
  return authProviders;
}

/**
 * Creates the MCP server, registers router tools, and starts the
 * stdio transport.
 */
async function startRouterServer(
  catalog: ToolCatalog,
  clients: Map<string, Client>,
  logger: Logger,
): Promise<void> {
  const router = new McpServer({
    name: 'mcp-compress-router',
    version: '1.0.0',
  });

  router.registerTool(
    'get_tool_schema',
    {
      title: 'Get Tool Schema',
      description: buildGetToolSchemaDescription(catalog),
      inputSchema: GetToolSchemaInputSchema,
    },
    createGetToolSchemaHandler(catalog, logger),
  );

  const invokeFn = (server: string, tool: string, args: Record<string, unknown>) =>
    invokeDownstreamTool(clients, server, tool, args, logger);

  router.registerTool(
    'invoke_tool',
    {
      title: 'Invoke Tool',
      description:
        'Invoke a specific tool on a connected MCP server. ' +
        'You MUST first use get_tool_schema to retrieve the required parameters ' +
        'for this tool before calling invoke_tool.',
      inputSchema: InvokeToolInputSchema,
    },
    createInvokeToolHandler(catalog, invokeFn, logger),
  );

  const transport = new StdioServerTransport();
  await router.connect(transport);
  logger.info('Server started on stdio');
}

/**
 * Runs the router: loads config, refreshes cached auth requirements,
 * connects to downstream servers, builds the catalog, and starts the
 * stdio MCP server.
 *
 * @param configPath - Explicit config path, or undefined for default.
 * @param verbose - When true, enables debug-level logging.
 */
export async function runRouter(configPath: string | undefined, verbose: boolean): Promise<void> {
  const logger = new Logger(verbose ? 'debug' : 'info');

  logger.info('Starting mcp-compress-router', {
    verbose,
    config: configPath ?? '(default)',
  });

  const resolved = await resolveConfigPath(configPath);
  logger.info('Loading configuration', { path: resolved });

  const servers = await loadConfig(resolved);
  logger.info('Configuration loaded', { serverCount: servers.length });

  await persistAuthRequirements(resolved, servers, logger);

  const authProviders = await buildAuthProviders(resolved, servers);
  const getAuthProvider = (server: DownstreamServerConfig) => authProviders.get(server.name);

  logger.info('Connecting to downstream servers', {
    servers: servers.map((s) => s.name),
  });
  const { servers: discovered, clients } = await connectAndDiscover(
    servers,
    logger,
    getAuthProvider,
  );
  logger.info('Tools discovered', {
    servers: discovered.map((d) => ({
      name: d.name,
      toolCount: d.tools.length,
      tools: d.tools.map((t) => t.name),
    })),
  });

  const selectionByServer = new Map<string, ToolSelection>();
  const compressionLevelByServer = new Map<string, CompressionLevel | undefined>();
  for (const server of servers) {
    selectionByServer.set(server.name, {
      allowedTools: server.allowedTools,
      disabledTools: server.disabledTools,
    });
    compressionLevelByServer.set(server.name, server.compressionLevel);
  }

  const catalog = buildCatalog(discovered, selectionByServer, logger, compressionLevelByServer);
  await startRouterServer(catalog, clients, logger);
}
