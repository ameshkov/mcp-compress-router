import process from 'node:process';
import {
  resolveConfigPath,
  persistAuthRequirements,
  loadConfig,
  ServerConnection,
  invokeWithRecovery,
  buildCatalog,
  replaceCatalogContents,
  ShutdownCoordinator,
  installShutdownTriggers,
} from '../services/index.js';
import type { DiscoveredServerData } from '../services/index.js';
import type {
  CompressionLevel,
  DownstreamServerConfig,
  ToolCatalog,
  ToolSelection,
} from '../utils/index.js';
import { Logger } from '../utils/index.js';
import { startRouterServer } from './router-server.js';
import type { InvokeDownstreamFn } from './router-server.js';

/**
 * Result of the connect phase: discovered data for every connected
 * server (success + degraded), or a marker that shutdown fired first.
 */
type ConnectOutcome = { discovered: DiscoveredServerData[] } | { shutdown: true };

/**
 * Connects to all enabled downstream servers via ServerConnection.
 * Disabled servers are skipped entirely. On failure, warm-cache
 * servers are degraded; cold-cache servers cause fail-fast.
 *
 * Each connection is registered in the shared `connections` map BEFORE
 * its connect starts, so a shutdown triggered mid-connect still tears
 * the in-flight child process down instead of orphaning it.
 *
 * @param servers - Validated downstream server configs.
 * @param configPath - Absolute path to the config file.
 * @param logger - Structured logger.
 * @param connections - Shared connection registry (populated as connects
 *   start; used for shutdown cleanup and runtime invocation).
 * @param coordinator - Shutdown coordinator (stops launching new
 *   connects once shutdown has started).
 * @returns Discovered data for every connected server, in config order.
 * @throws When a server cannot connect AND has no tool cache.
 */
async function connectAllServers(
  servers: DownstreamServerConfig[],
  configPath: string,
  logger: Logger,
  connections: Map<string, ServerConnection>,
  coordinator: ShutdownCoordinator,
): Promise<DiscoveredServerData[]> {
  const enabledServers = servers.filter((server) => {
    if (server.enabled === false) {
      logger.info(`Skipping disabled server "${server.name}"`, { server: server.name });
      return false;
    }
    return true;
  });

  const results = await Promise.all(
    enabledServers.map(async (server) => {
      if (coordinator.isShuttingDown) {
        return undefined;
      }
      const conn = new ServerConnection(server, configPath, logger);
      connections.set(conn.serverName, conn);
      if (coordinator.isShuttingDown) {
        return undefined;
      }
      const ds = await conn.connect();
      return { conn, ds };
    }),
  );

  const discovered: DiscoveredServerData[] = [];
  for (const result of results) {
    if (result) {
      discovered.push(result.ds);
    }
  }
  return discovered;
}

/**
 * Closes every downstream server connection in parallel. Each
 * `ServerConnection.close()` drives the SDK's graduated kill (end stdin,
 * SIGTERM, then SIGKILL) so spawned downstream servers are terminated
 * rather than orphaned when the router exits.
 *
 * @param connections - Live ServerConnection instances keyed by name.
 * @param logger - Structured logger.
 */
async function closeAllConnections(
  connections: Map<string, ServerConnection>,
  logger: Logger,
): Promise<void> {
  logger.info('Closing downstream server connections', {
    servers: [...connections.keys()],
  });
  await Promise.all([...connections.values()].map((conn) => conn.close().catch(() => {})));
}

/**
 * Loads the config file and derives the per-server tool-selection and
 * compression-level maps used for filtering/rendering.
 */
async function loadConfigForRun(
  configPath: string | undefined,
  verbose: boolean,
  logger: Logger,
): Promise<{
  resolved: string;
  servers: DownstreamServerConfig[];
  selectionByServer: Map<string, ToolSelection>;
  compressionLevelByServer: Map<string, CompressionLevel | undefined>;
}> {
  logger.info('Starting mcp-compress-router', {
    verbose,
    config: configPath ?? '(default)',
  });

  const resolved = await resolveConfigPath(configPath);
  logger.info('Loading configuration', { path: resolved });

  const servers = await loadConfig(resolved);
  logger.info('Configuration loaded', { serverCount: servers.length });

  const selectionByServer = new Map<string, ToolSelection>();
  const compressionLevelByServer = new Map<string, CompressionLevel | undefined>();
  for (const server of servers) {
    selectionByServer.set(server.name, {
      allowedTools: server.allowedTools,
      disabledTools: server.disabledTools,
    });
    compressionLevelByServer.set(server.name, server.compressionLevel);
  }
  return { resolved, servers, selectionByServer, compressionLevelByServer };
}

/**
 * Installs the shutdown coordinator + triggers and the shared connection
 * registry. MUST run before any downstream child is spawned so a host
 * disconnect during the connect phase tears in-flight children down.
 */
function installShutdownManager(logger: Logger): {
  coordinator: ShutdownCoordinator;
  connections: Map<string, ServerConnection>;
} {
  const connections = new Map<string, ServerConnection>();
  const coordinator = new ShutdownCoordinator(logger);
  coordinator.register(() => closeAllConnections(connections, logger));
  installShutdownTriggers(coordinator, logger);
  return { coordinator, connections };
}

/**
 * Creates the empty live catalog, its ready signal, and the downstream
 * invocation function. Tool handlers hold the catalog by reference; the
 * final contents are published in place once discovery completes.
 */
function createCatalogState(
  connections: Map<string, ServerConnection>,
  selectionByServer: Map<string, ToolSelection>,
  logger: Logger,
): {
  catalog: ToolCatalog;
  catalogReady: Promise<void>;
  markCatalogReady: () => void;
  invokeFn: InvokeDownstreamFn;
} {
  const catalog: ToolCatalog = {
    servers: [],
    toolMap: new Map(),
    filteredToolNames: new Set(),
  };
  let markCatalogReady!: () => void;
  const catalogReady = new Promise<void>((resolve) => {
    markCatalogReady = resolve;
  });
  const invokeFn = async (server: string, tool: string, args: Record<string, unknown>) => {
    return invokeWithRecovery(server, tool, args, catalog, connections, selectionByServer, logger);
  };
  return { catalog, catalogReady, markCatalogReady, invokeFn };
}

/**
 * Kicks off the downstream connect phase (including the OAuth
 * auth-requirement refresh) without awaiting it. Both phases run in
 * parallel, each bounded by per-operation timeouts.
 */
function launchConnectPhase(
  servers: DownstreamServerConfig[],
  resolved: string,
  connections: Map<string, ServerConnection>,
  coordinator: ShutdownCoordinator,
  logger: Logger,
): Promise<DiscoveredServerData[]> {
  return (async (): Promise<DiscoveredServerData[]> => {
    const [authRefresh, connectResult] = await Promise.allSettled([
      persistAuthRequirements(resolved, servers, logger),
      connectAllServers(servers, resolved, logger, connections, coordinator),
    ]);
    if (connectResult.status === 'rejected') {
      throw connectResult.reason;
    }
    if (authRefresh.status === 'rejected') {
      throw authRefresh.reason;
    }
    return connectResult.value;
  })();
}

/**
 * Awaits the connect phase, racing it against shutdown. On shutdown the
 * connect phase is abandoned (its in-flight children were already closed
 * by the cleanup hooks). On a cold connect failure, cleanup runs first,
 * then the error is rethrown so the entry point logs + exits non-zero.
 */
async function awaitConnectOutcome(
  connectPhase: Promise<DiscoveredServerData[]>,
  coordinator: ShutdownCoordinator,
): Promise<ConnectOutcome> {
  try {
    return await Promise.race([
      connectPhase.then((discovered) => ({ discovered })),
      coordinator.whenShutdownStarted().then(() => ({ shutdown: true as const })),
    ]);
  } catch (err) {
    await coordinator.shutdown('startup-failure');
    throw err;
  }
}

/**
 * Publishes the discovered servers into the live catalog, unblocks
 * tools/list, and logs the discovery summary.
 */
function publishCatalog(
  catalog: ToolCatalog,
  markCatalogReady: () => void,
  discovered: DiscoveredServerData[],
  selectionByServer: Map<string, ToolSelection>,
  compressionLevelByServer: Map<string, CompressionLevel | undefined>,
  logger: Logger,
): void {
  replaceCatalogContents(
    catalog,
    buildCatalog(discovered, selectionByServer, logger, compressionLevelByServer),
  );
  markCatalogReady();

  logger.info('Tools discovered', {
    servers: discovered.map((d) => ({
      name: d.name,
      toolCount: d.tools.length,
      status: d.status,
    })),
  });
}

/**
 * Runs the router: starts the host-facing stdio server IMMEDIATELY (so
 * the host's `initialize` is answered without waiting for downstream
 * connects), then connects to downstream servers concurrently, publishes
 * the discovered tools into the live catalog, and blocks until a
 * shutdown trigger fires.
 *
 * Shutdown triggers are installed before ANY network activity so a host
 * disconnect during the connect phase still tears down in-flight
 * downstream children (the most common cause of orphaned processes).
 *
 * @param configPath - Explicit config path, or undefined for default.
 * @param verbose - When true, enables debug-level logging.
 */
export async function runRouter(configPath: string | undefined, verbose: boolean): Promise<void> {
  const logger = new Logger(verbose ? 'debug' : 'info');
  const { resolved, servers, selectionByServer, compressionLevelByServer } = await loadConfigForRun(
    configPath,
    verbose,
    logger,
  );
  const { coordinator, connections } = installShutdownManager(logger);
  const { catalog, catalogReady, markCatalogReady, invokeFn } = createCatalogState(
    connections,
    selectionByServer,
    logger,
  );

  const closeRouter = await startRouterServer(catalog, invokeFn, logger, coordinator, catalogReady);
  coordinator.register(closeRouter);

  const outcome = await awaitConnectOutcome(
    launchConnectPhase(servers, resolved, connections, coordinator, logger),
    coordinator,
  );
  if ('shutdown' in outcome) {
    await coordinator.whenShutdown();
    process.exit(0);
  }

  publishCatalog(
    catalog,
    markCatalogReady,
    outcome.discovered,
    selectionByServer,
    compressionLevelByServer,
    logger,
  );

  // Block here until a shutdown trigger fires (signal or stdin EOF), then
  // force-exit so lingering grandchild pipes (e.g. browser processes
  // forked by a downstream server) cannot keep the router alive. Without
  // this, the router would linger as a ghost process forever.
  await coordinator.whenShutdown();
  process.exit(0);
}
