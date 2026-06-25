import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { DownstreamServerConfig, ToolDescriptor, Logger } from '../utils/index.js';

/** JSON-RPC error code for "Method not found". */
const METHOD_NOT_FOUND = -32601;

/**
 * Returns true when an error is a JSON-RPC "Method not found" response,
 * which a downstream server returns for `tools/list` when it advertises
 * no tools. Detected via duck-typing to avoid importing the SDK error
 * class.
 *
 * @param err - The thrown value from `listTools()`.
 */
function isMethodNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === METHOD_NOT_FOUND
  );
}

/**
 * Lists tools from a connected client. A server that registers no tools
 * does not implement the `tools/list` method and responds with -32601
 * Method not found; that is normalized to an empty toolset rather than
 * propagated as a connection failure.
 *
 * @param client - A connected MCP client.
 * @returns The list-tools result (possibly empty).
 * @throws Any non-"Method not found" error from `listTools()`.
 */
async function listToolsOrEmpty(client: Client): Promise<{
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
}> {
  try {
    return await client.listTools();
  } catch (err) {
    if (isMethodNotFound(err)) {
      return { tools: [] };
    }
    throw err;
  }
}

/**
 * Result of connecting to and discovering tools from a downstream server.
 */
export interface DiscoveredServer {
  /** The server name (from config). */
  name: string;
  /** The server's optional description. */
  description?: string;
  /** Discovered tool descriptors. */
  tools: ToolDescriptor[];
}

/**
 * Result of connecting to and discovering tools from downstream
 * servers, including live client connections for later invocation.
 *
 * @public
 */
export interface DiscoveryResult {
  /** Discovered server data for each server. */
  servers: DiscoveredServer[];
  /** Live MCP client connections keyed by server name. */
  clients: Map<string, Client>;
}

/**
 * Connects to all configured stdio servers in parallel and discovers
 * their tools. Fails fast if any server is unreachable.
 *
 * @param servers - Validated downstream server configs.
 * @param logger - Structured logger for diagnostic output.
 * @param getAuthProvider - Optional factory to provide OAuth credentials for HTTP servers.
 * @returns Discovered server data and live client connections.
 * @throws If any server cannot be connected or tools cannot be listed.
 */
export async function connectAndDiscover(
  servers: DownstreamServerConfig[],
  logger: Logger,
  getAuthProvider?: (server: DownstreamServerConfig) => OAuthClientProvider | undefined,
): Promise<DiscoveryResult> {
  const enabledServers: DownstreamServerConfig[] = [];
  for (const server of servers) {
    if (server.enabled === false) {
      logger.info(`Skipping disabled server "${server.name}"`, {
        server: server.name,
      });
    } else {
      enabledServers.push(server);
    }
  }

  const results = await Promise.all(
    enabledServers.map((server) => connectSingleServer(server, logger, getAuthProvider)),
  );

  const serversList: DiscoveredServer[] = [];
  const clients = new Map<string, Client>();

  for (const { server, client } of results) {
    serversList.push(server);
    clients.set(server.name, client);
  }

  return { servers: serversList, clients };
}

/**
 * Connects to a single downstream server, lists its tools, and closes
 * the connection. Unlike {@link connectAndDiscover}, this function does
 * NOT inspect the server's `enabled` flag — it always probes live. It
 * is the engine behind the `tools <name>` inspection command, which
 * must work for disabled servers (building an allowlist for a disabled
 * server is the primary configuration workflow).
 *
 * The returned {@link DiscoveredServer} carries every advertised tool;
 * callers apply the Tool Filter themselves to compute exposure marks.
 *
 * @param server - Downstream server configuration (any `enabled` value).
 * @param logger - Structured logger for diagnostic output.
 * @param getAuthProvider - Optional factory to provide OAuth credentials
 *   for HTTP servers.
 * @returns The discovered server data (name, description, tools).
 * @throws If the server cannot be connected or tools cannot be listed.
 * @public
 */
export async function discoverSingleServer(
  server: DownstreamServerConfig,
  logger: Logger,
  getAuthProvider?: (s: DownstreamServerConfig) => OAuthClientProvider | undefined,
): Promise<DiscoveredServer> {
  const { client, server: discovered } = await connectSingleServer(server, logger, getAuthProvider);
  await client.close();
  return discovered;
}

/**
 * Connects to a single downstream server and discovers its tools.
 *
 * @param server - Downstream server configuration.
 * @param logger - Structured logger for diagnostic output.
 * @param getAuthProvider - Optional factory to provide OAuth credentials.
 * @returns The discovered server data and live client connection.
 * @throws If the server cannot be connected or tools cannot be listed.
 */
async function connectSingleServer(
  server: DownstreamServerConfig,
  logger: Logger,
  getAuthProvider?: (s: DownstreamServerConfig) => OAuthClientProvider | undefined,
): Promise<{ server: DiscoveredServer; client: Client }> {
  const client = new Client(
    { name: 'mcp-compress-router', version: '1.0.0' },
    { capabilities: {} },
  );

  logger.info(`Connecting to downstream server "${server.name}"`, {
    server: server.name,
    type: server.type,
  });

  const transport = createTransport(server, getAuthProvider);

  try {
    await client.connect(transport);
    const listResult = await listToolsOrEmpty(client);

    logger.info(`Connected to "${server.name}" — ${listResult.tools.length} tools discovered`, {
      server: server.name,
      toolCount: listResult.tools.length,
      tools: listResult.tools.map((t) => t.name),
    });

    const tools: ToolDescriptor[] = listResult.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));

    return {
      server: {
        name: server.name,
        description: server.description,
        tools,
      },
      client,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to connect to server "${server.name}"`, {
      server: server.name,
      type: server.type,
      error: message,
    });
    throw new Error(`Failed to connect to server "${server.name}": ${message}`);
  }
}

/**
 * Creates the appropriate transport for a downstream server config.
 *
 * @param server - Downstream server configuration.
 * @param getAuthProvider - Optional factory to provide OAuth credentials.
 * @returns A configured transport instance (stdio or HTTP).
 * @throws If required configuration (command or url) is missing.
 */
function createTransport(
  server: DownstreamServerConfig,
  getAuthProvider?: (s: DownstreamServerConfig) => OAuthClientProvider | undefined,
): StdioClientTransport | StreamableHTTPClientTransport {
  if (server.type === 'stdio') {
    if (!server.command) {
      throw new Error(`Server "${server.name}" (stdio) is missing command`);
    }
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: server.env,
    });
  }

  // http or streamable-http
  if (!server.url) {
    throw new Error(`Server "${server.name}" (${server.type}) is missing url`);
  }
  const requestInit: RequestInit = {};
  if (server.headers) {
    requestInit.headers = server.headers as Record<string, string>;
  }
  const authProvider = getAuthProvider?.(server);
  return new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: Object.keys(requestInit).length > 0 ? requestInit : undefined,
    authProvider,
  });
}
