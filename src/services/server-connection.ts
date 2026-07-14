import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { createTransport, listToolsOrEmpty } from './discovery.js';
import { OAuthCredentialManager } from './oauth.js';
import { saveToolCache, loadToolCache } from './tool-cache.js';
import { isAuthError } from './index.js';
import type {
  DownstreamServerConfig,
  Logger,
  ServerStatus,
  ToolDescriptor,
} from '../utils/index.js';

/**
 * Result shape returned by `client.callTool()`, matching the MCP SDK
 * `CallToolResult` structure (content blocks + optional error flag).
 */
export interface InvokeResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * 30-second cooldown after a failed reconnect attempt. Subsequent
 * `invokeWithRecovery` calls within this window return the cached
 * guided error immediately without retrying the connection.
 */
const RECONNECT_COOLDOWN_MS = 30_000;

/**
 * Encapsulates the per-server client lifecycle: initial connect,
 * reconnect (self-recovery), tool invocation, proactive OAuth refresh,
 * and shutdown. Each instance owns exactly one `Client` and one
 * `OAuthCredentialManager`.
 *
 * The `connect()` method is the startup path: on success it saves the
 * tool cache; on failure it loads the cache and returns a degraded
 * `DiscoveredServer` (throws only when no cache exists — cold fail-fast).
 * The `reconnect()` method is the recovery path: it always throws on
 * failure so the caller can surface a guided error.
 *
 * `reconnect()` creates a fresh `OAuthCredentialManager` on each call,
 * reading the latest tokens from `credentials.json` on disk. This is
 * how the running router picks up credentials saved by `login` in
 * another process.
 */
export class ServerConnection {
  private client: Client | undefined;
  private authProvider: OAuthCredentialManager | undefined;
  private _status: ServerStatus = 'ok';
  private _lastError: string | undefined;
  private _lastReconnectAt: number = 0;
  private _reconnectInFlight: Promise<DiscoveredServerData> | undefined;

  /**
   * @param server - The downstream server configuration.
   * @param configPath - Absolute path to mcp.json (for credentials + cache).
   * @param logger - Structured logger for diagnostic output.
   */
  constructor(
    private readonly server: DownstreamServerConfig,
    private readonly configPath: string,
    private readonly logger: Logger,
  ) {}

  /** Current connection status. */
  get status(): ServerStatus {
    return this._status;
  }

  /** The underlying error message from the last failed connect/reconnect. */
  get lastError(): string | undefined {
    return this._lastError;
  }

  /** Timestamp (ms) of the last reconnect attempt. 0 if never attempted. */
  get lastReconnectAt(): number {
    return this._lastReconnectAt;
  }

  /** Whether the cooldown window has elapsed since the last reconnect.
   *  Always `true` for a healthy (`'ok'`) server — a successful reconnect
   *  resets the cooldown so subsequent recovery is not blocked. */
  get cooldownElapsed(): boolean {
    if (this._status === 'ok') {
      return true;
    }
    return Date.now() - this._lastReconnectAt >= RECONNECT_COOLDOWN_MS;
  }

  /** The server name. */
  get serverName(): string {
    return this.server.name;
  }

  /** The downstream server configuration. Used by `invokeWithRecovery`
   *  to build accurate guided error messages (needs server type,
   *  command, etc.). */
  get serverConfig(): DownstreamServerConfig {
    return this.server;
  }

  /**
   * Initial connection (startup path). On success, saves tools to cache
   * and returns with status 'ok'. On failure, loads the cache; if cache
   * exists, returns a degraded DiscoveredServer with cached tools and
   * status 'unauthorized' or 'unavailable'. If no cache exists (cold),
   * re-throws the original error so the router fails fast.
   *
   * @returns Discovered server data (name, description, tools, status).
   * @throws When the server cannot connect AND no tool cache exists.
   */
  async connect(): Promise<DiscoveredServerData> {
    try {
      const tools = await this.doConnect();
      this._status = 'ok';
      this._lastError = undefined;
      await saveToolCache(this.configPath, this.server.name, tools);
      this.logger.info(`Connected to "${this.server.name}" — ${tools.length} tools discovered`, {
        server: this.server.name,
        toolCount: tools.length,
      });
      return {
        name: this.server.name,
        description: this.server.description,
        tools,
        status: 'ok',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._lastError = message;
      // Tear down any half-initialized client so a degraded connection
      // holds no lingering transport/child process; recovery will build
      // a fresh client on demand via reconnect().
      await this.closeClient();

      const cachedTools = await loadToolCache(this.configPath, this.server.name);
      if (cachedTools === undefined) {
        this.logger.error(`Failed to connect to server "${this.server.name}" (no cache)`, {
          server: this.server.name,
          type: this.server.type,
          error: message,
        });
        throw new Error(`Failed to connect to server "${this.server.name}": ${message}`, {
          cause: err,
        });
      }

      const status: ServerStatus = isAuthError(err) ? 'unauthorized' : 'unavailable';
      this._status = status;
      this.logger.warn(
        `Server "${this.server.name}" failed (${status}) — using ${cachedTools.length} cached tools`,
        { server: this.server.name, type: this.server.type, error: message, status },
      );
      return {
        name: this.server.name,
        description: this.server.description,
        tools: cachedTools,
        status,
      };
    }
  }

  /**
   * Re-reads credentials from disk, creates a fresh client + transport,
   * connects, lists tools, and saves the cache. Deduplicates concurrent
   * calls. Always throws on failure (caller surfaces guided error).
   *
   * @returns Discovered server data (name, description, tools, status 'ok').
   * @throws When reconnection fails.
   */
  async reconnect(): Promise<DiscoveredServerData> {
    if (this._reconnectInFlight) {
      return this._reconnectInFlight;
    }
    this._reconnectInFlight = this.doReconnect().finally(() => {
      this._reconnectInFlight = undefined;
    });
    return this._reconnectInFlight;
  }

  /**
   * If a reconnect is currently in flight for this server, awaits its
   * result. Resolves (never rejects) with the reconnect data when it
   * succeeded, or `undefined` when no reconnect is in flight — or when
   * the in-flight reconnect failed, so the caller can fall back to its
   * own cooldown / guided-error path.
   *
   * Lets a concurrent `invoke_tool` call that arrives while a degraded
   * server's reconnect is already running coalesce onto that reconnect
   * instead of short-circuiting on the cooldown (which would otherwise
   * surface a stale guided error moments before the reconnect succeeds).
   *
   * @returns The in-flight reconnect's data, or `undefined` when none.
   */
  async awaitReconnectInFlight(): Promise<DiscoveredServerData | undefined> {
    const inflight = this._reconnectInFlight;
    if (!inflight) {
      return undefined;
    }
    try {
      return await inflight;
    } catch {
      return undefined;
    }
  }

  private async doReconnect(): Promise<DiscoveredServerData> {
    this._lastReconnectAt = Date.now();
    try {
      await this.closeClient();
      const tools = await this.doConnect();
      this._status = 'ok';
      this._lastError = undefined;
      await saveToolCache(this.configPath, this.server.name, tools);
      this.logger.info(`Reconnected to "${this.server.name}" — ${tools.length} tools discovered`, {
        server: this.server.name,
        toolCount: tools.length,
      });
      return {
        name: this.server.name,
        description: this.server.description,
        tools,
        status: 'ok',
      };
    } catch (err) {
      // Record the failure on the connection so the cooldown engages
      // (status != 'ok') and subsequent callers see the real reason
      // rather than re-running the full connect→fail cycle with no
      // backoff. Auth failures are classified as 'unauthorized' so
      // guided errors point at `login` instead of "connection failed".
      this._lastError = err instanceof Error ? err.message : String(err);
      this._status = isAuthError(err) ? 'unauthorized' : 'unavailable';
      throw err;
    }
  }

  /**
   * Creates a fresh client, creates the transport (with a fresh auth
   * provider if applicable), connects, and lists tools. Does NOT save
   * the cache — the caller is responsible for that.
   */
  private async doConnect(): Promise<ToolDescriptor[]> {
    this.client = new Client(
      { name: 'mcp-compress-router', version: '1.0.0' },
      { capabilities: {} },
    );

    this.authProvider = await this.createAuthProvider();
    const getAuthProvider = this.authProvider
      ? (_s: DownstreamServerConfig) => this.authProvider as OAuthClientProvider
      : undefined;
    const transport = createTransport(this.server, getAuthProvider);

    await this.client.connect(transport);
    const listResult = await listToolsOrEmpty(this.client);

    return listResult.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  /**
   * Creates a fresh OAuthCredentialManager for this server, reading the
   * latest credentials from disk. Returns undefined for stdio servers
   * or HTTP servers without stored credentials or OAuth overrides.
   */
  private async createAuthProvider(): Promise<OAuthCredentialManager | undefined> {
    if (this.server.type !== 'http' && this.server.type !== 'streamable-http') {
      return undefined;
    }
    const mgr = new OAuthCredentialManager(this.configPath, this.server);
    const hasCredentials = (await mgr.tokens()) !== undefined;
    const hasOverrides = this.server.oauth?.clientId !== undefined;
    if (hasCredentials || hasOverrides) {
      return mgr;
    }
    return undefined;
  }

  /**
   * Best-effort proactive OAuth token refresh. Delegates to the auth
   * provider's `refreshIfNeeded`. No-op for servers without an auth
   * provider.
   */
  async refreshTokens(): Promise<void> {
    if (this.authProvider) {
      await this.authProvider.refreshIfNeeded(this.logger);
    }
  }

  /**
   * Invokes a tool on the downstream server via the live client.
   *
   * @param tool - The tool name to invoke.
   * @param args - The arguments to pass to the tool.
   * @returns The downstream call result verbatim.
   * @throws When no client is connected or the downstream call fails.
   */
  async invokeTool(tool: string, args: Record<string, unknown>): Promise<InvokeResult> {
    if (!this.client) {
      throw new Error(`Server "${this.server.name}" has no active client connection.`);
    }
    const result = (await this.client.callTool({
      name: tool,
      arguments: args,
    })) as InvokeResult;
    return result;
  }

  /**
   * Closes the downstream client connection. Safe to call multiple times.
   */
  async close(): Promise<void> {
    await this.closeClient();
  }

  private async closeClient(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors during cleanup.
      }
      this.client = undefined;
    }
  }
}

/**
 * Internal shape returned by `ServerConnection.connect()` and
 * `reconnect()`. Mirrors `DiscoveredServer` but with a required
 * `status` field.
 */
export interface DiscoveredServerData {
  /** The server name (from config). */
  name: string;
  /** The server's optional description. */
  description?: string;
  /** Discovered or cached tool descriptors. */
  tools: ToolDescriptor[];
  /** Current connection status. */
  status: ServerStatus;
}
