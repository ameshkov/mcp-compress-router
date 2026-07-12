import {
  resolveConfigPath,
  persistAuthRequirements,
  loadConfig,
  ServerConnection,
  invokeWithRecovery,
  buildCatalog,
} from '../services/index.js';
import type { DiscoveredServerData } from '../services/index.js';
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
 * Connects to all enabled downstream servers via ServerConnection.
 * Disabled servers are skipped entirely. On failure, warm-cache
 * servers are degraded; cold-cache servers cause fail-fast.
 *
 * @param servers - Validated downstream server configs.
 * @param configPath - Absolute path to the config file.
 * @param logger - Structured logger.
 * @returns Map of server name to ServerConnection and discovered data.
 * @throws When a server cannot connect AND has no tool cache.
 */
async function connectAllServers(
  servers: DownstreamServerConfig[],
  configPath: string,
  logger: Logger,
): Promise<{ connections: Map<string, ServerConnection>; discovered: DiscoveredServerData[] }> {
  const enabledServers = servers.filter((server) => {
    if (server.enabled === false) {
      logger.info(`Skipping disabled server "${server.name}"`, { server: server.name });
      return false;
    }
    return true;
  });

  const results = await Promise.all(
    enabledServers.map(async (server) => {
      const conn = new ServerConnection(server, configPath, logger);
      const ds = await conn.connect();
      return { conn, ds };
    }),
  );

  const connections = new Map<string, ServerConnection>();
  const discovered: DiscoveredServerData[] = [];

  for (const { conn, ds } of results) {
    connections.set(conn.serverName, conn);
    discovered.push(ds);
  }

  return { connections, discovered };
}

/**
 * Creates the MCP server, registers router tools, and starts the
 * stdio transport.
 *
 * @param catalog - The mutable tool catalog.
 * @param connections - Live ServerConnection instances keyed by name.
 * @param selectionByServer - Per-server tool selection for re-filtering.
 * @param logger - Structured logger.
 */
async function startRouterServer(
  catalog: ToolCatalog,
  connections: Map<string, ServerConnection>,
  selectionByServer: Map<string, ToolSelection>,
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

  const invokeFn = async (server: string, tool: string, args: Record<string, unknown>) => {
    return invokeWithRecovery(server, tool, args, catalog, connections, selectionByServer, logger);
  };

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

  logger.info('Connecting to downstream servers', {
    servers: servers.map((s) => s.name),
  });
  const { connections, discovered } = await connectAllServers(servers, resolved, logger);
  logger.info('Tools discovered', {
    servers: discovered.map((d) => ({
      name: d.name,
      toolCount: d.tools.length,
      status: d.status,
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
  await startRouterServer(catalog, connections, selectionByServer, logger);
}
