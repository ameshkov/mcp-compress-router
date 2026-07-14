import type { ServerConnection, InvokeResult } from './server-connection.js';
import { updateServerInCatalog } from './catalog.js';
import { buildGuidedError, isAuthError } from './index.js';
import type {
  DownstreamServerConfig,
  ServerStatus,
  ToolCatalog,
  ToolSelection,
  Logger,
} from '../utils/index.js';

/**
 * Set of error message substrings that indicate a recoverable
 * network/transport failure (as opposed to a tool-level or protocol
 * error that retrying will not fix).
 */
const RECOVERABLE_PATTERNS = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'socket hang up',
  'fetch failed',
];

/**
 * Determines whether an error from `invokeTool` is worth a reconnect +
 * retry. Returns true for auth errors (user may have run `login`) and
 * network-level failures. Returns false for tool-not-found, argument
 * validation, and JSON-RPC method errors.
 *
 * @internal Exported for tests only; not part of the public module API.
 *   Tests classify errors the same way the recovery orchestrator does.
 *
 * @param err - The error thrown by `client.callTool()`.
 * @returns True when a reconnect + retry might succeed.
 */
export function isRecoverable(err: unknown): boolean {
  if (isAuthError(err)) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return RECOVERABLE_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Invokes a tool on a downstream server, with automatic self-recovery
 * for degraded servers and runtime failures.
 *
 * **Concurrent reconnect coalescing**: before anything else, awaits any
 * reconnect that is already in flight for this server. This lets a
 * concurrent `invoke_tool` call (whether the server is OK or degraded)
 * join an about-to-succeed reconnect instead of racing into
 * `invokeTool` with a torn-down client or short-circuiting on cooldown.
 *
 * **Degraded server (status != 'ok')**: If the cooldown window has
 * elapsed, attempts `reconnect()`. On success, updates the catalog and
 * proceeds to invoke. On failure, throws a guided error. If within
 * cooldown, returns the cached error immediately.
 *
 * **OK server**: Refreshes tokens, invokes the tool. On a recoverable
 * runtime failure, attempts one reconnect + retry. On a non-recoverable
 * error, re-throws the original error.
 *
 * @param server - The server name.
 * @param tool - The tool name to invoke.
 * @param args - The arguments to pass to the tool.
 * @param catalog - The mutable tool catalog.
 * @param connections - Map of server name to ServerConnection.
 * @param selectionByServer - Per-server tool selection (for re-filtering
 *   after reconnect).
 * @param logger - Structured logger.
 * @returns The downstream call result.
 * @throws A guided Error when the server cannot be reached, or the
 *   original error for non-recoverable failures.
 */
export async function invokeWithRecovery(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  catalog: ToolCatalog,
  connections: Map<string, ServerConnection>,
  selectionByServer: Map<string, ToolSelection>,
  logger: Logger,
): Promise<InvokeResult> {
  const conn = connections.get(server);
  if (!conn) {
    throw new Error(`Unknown server "${server}". Available: ${[...connections.keys()].join(', ')}`);
  }

  const serverConfig = conn.serverConfig;
  const selection = selectionByServer.get(server);

  // Join any reconnect already in flight for this server. If one just
  // resolved successfully, refresh the catalog with its freshly-
  // discovered tools (idempotent — the initiator also updates). This
  // coalesces concurrent invokes onto a shared reconnect instead of
  // racing into invokeTool with a torn-down client or short-circuiting
  // on cooldown; once resolved, the client is live and status reflects
  // the outcome, so the normal path below proceeds.
  const inFlight = await conn.awaitReconnectInFlight();
  if (inFlight) {
    updateServerInCatalog(catalog, server, inFlight.tools, 'ok', selection);
  }

  if (conn.status !== 'ok') {
    await recoverDegradedServer(conn, server, serverConfig, selection, catalog, logger);
  }

  return invokeToolWithRetry(conn, tool, args, server, serverConfig, selection, catalog, logger);
}

/**
 * Self-recovery path for a degraded server. When the cooldown window
 * has elapsed, reconnects and updates the catalog. Within cooldown,
 * or when reconnect fails, throws a guided error.
 */
async function recoverDegradedServer(
  conn: ServerConnection,
  server: string,
  serverConfig: DownstreamServerConfig,
  selection: ToolSelection | undefined,
  catalog: ToolCatalog,
  logger: Logger,
): Promise<void> {
  if (!conn.cooldownElapsed) {
    logger.debug(`Recovery skipped (cooldown) for "${server}"`, {
      server,
      status: conn.status,
      lastError: conn.lastError,
    });
    throw buildGuidedError(
      serverConfig,
      new Error(conn.lastError ?? 'Connection failed'),
      conn.status,
      false,
    );
  }

  try {
    const ds = await conn.reconnect();
    updateServerInCatalog(catalog, server, ds.tools, 'ok', selection);
    logger.info(`Self-recovery succeeded for "${server}"`, { server, toolCount: ds.tools.length });
  } catch (err) {
    logger.error(`Self-recovery failed for "${server}"`, {
      server,
      error: err instanceof Error ? err.message : String(err),
    });
    throw buildGuidedError(serverConfig, err, conn.status, true);
  }
}

/**
 * Refreshes tokens, invokes the tool, and on a recoverable runtime
 * failure attempts one reconnect + retry. Non-recoverable errors and
 * failed retries throw (guided error for retries, original error
 * otherwise).
 */
async function invokeToolWithRetry(
  conn: ServerConnection,
  tool: string,
  args: Record<string, unknown>,
  server: string,
  serverConfig: DownstreamServerConfig,
  selection: ToolSelection | undefined,
  catalog: ToolCatalog,
  logger: Logger,
): Promise<InvokeResult> {
  await conn.refreshTokens();

  try {
    return await conn.invokeTool(tool, args);
  } catch (err) {
    if (!isRecoverable(err)) {
      throw err;
    }
    logger.warn(`Runtime failure on "${server}", attempting reconnect`, {
      server,
      tool,
      error: err instanceof Error ? err.message : String(err),
    });
    // Track whether reconnect itself succeeded so a post-reconnect
    // invoke failure is classified from the error itself, not masked
    // as 'unavailable' — which would hide a 'requires login' state
    // behind a generic connection-failure message.
    let reconnectSucceeded = false;
    try {
      const ds = await conn.reconnect();
      updateServerInCatalog(catalog, server, ds.tools, 'ok', selection);
      reconnectSucceeded = true;
      return await conn.invokeTool(tool, args);
    } catch (retryErr) {
      if (reconnectSucceeded) {
        // Reconnect succeeded but the retried invoke failed. The
        // server is reachable, so 'unavailable' would be misleading —
        // surface auth errors as 'authentication required', re-throw
        // the rest as-is so the caller sees the real downstream error.
        if (isAuthError(retryErr)) {
          throw buildGuidedError(serverConfig, retryErr, 'unauthorized', true);
        }
        throw retryErr;
      }
      // Reconnect itself failed: the server is down or requires auth.
      // doReconnect has already transitioned the connection's status
      // + cooldown so subsequent calls back off.
      const status: ServerStatus = isAuthError(retryErr) ? 'unauthorized' : 'unavailable';
      throw buildGuidedError(serverConfig, retryErr, status, true);
    }
  }
}
