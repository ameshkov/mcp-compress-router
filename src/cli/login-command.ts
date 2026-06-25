import type { DownstreamServerConfig } from '../utils/index.js';
import { ensureConfigDir, readConfigFile, type RawServerEntry } from './config-io.js';
import { loadConfig } from '../services/config.js';
import { discoverAuth } from '../services/index.js';

/** SDK OAuth metadata type (non-null after discovery). */
type OAuthMetadata = NonNullable<
  Awaited<
    ReturnType<
      typeof import('@modelcontextprotocol/sdk/client/auth.js').discoverAuthorizationServerMetadata
    >
  >
>;

/** SDK `startAuthorization` result type. */
type AuthResult = Awaited<
  ReturnType<typeof import('@modelcontextprotocol/sdk/client/auth.js').startAuthorization>
>;

/**
 * Validates that a server exists in config and is eligible for OAuth login.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name to validate.
 * @returns The raw server entry and the typed downstream config.
 * @throws If the server is not found or is not an HTTP type.
 */
async function validateServerForLogin(
  configPath: string,
  name: string,
): Promise<{ entry: RawServerEntry; targetServer: DownstreamServerConfig }> {
  await ensureConfigDir(configPath);
  const servers = await readConfigFile(configPath);

  if (!(name in servers)) {
    const available = Object.keys(servers);
    const hint =
      available.length > 0
        ? ` Available servers: ${available.join(', ')}`
        : ' No servers configured.';
    throw new Error(`Server "${name}" not found.${hint}`);
  }

  const entry = servers[name];

  if (entry.type !== 'http' && entry.type !== 'streamable-http') {
    throw new Error(
      `Server "${name}" is type "${entry.type}". OAuth is only supported for HTTP servers.`,
    );
  }

  const allConfigs = await loadConfig(configPath);
  const targetServer = allConfigs.find((s) => s.name === name);
  if (!targetServer) {
    throw new Error(`Server "${name}" not found in configuration.`);
  }

  return { entry, targetServer };
}

// Cached lazy imports for SDK OAuth modules.
let _sdkAuth: typeof import('@modelcontextprotocol/sdk/client/auth.js') | undefined;

async function _getSdkAuth(): Promise<typeof import('@modelcontextprotocol/sdk/client/auth.js')> {
  if (!_sdkAuth) {
    _sdkAuth = await import('@modelcontextprotocol/sdk/client/auth.js');
  }
  return _sdkAuth;
}

/**
 * Discovers OAuth metadata and registers the client if dynamic registration
 * is needed.
 *
 * @param mgr - OAuth credential manager for the target server.
 * @param targetServer - Typed downstream server configuration.
 * @param name - Server name (for error messages).
 * @returns The discovered OAuth metadata (non-null after validation).
 * @throws If the server does not expose OAuth metadata or registration.
 */
async function setupOAuthClient(
  mgr: import('../services/oauth.js').OAuthCredentialManager,
  targetServer: DownstreamServerConfig,
  name: string,
): Promise<OAuthMetadata> {
  const { registerClient } = await _getSdkAuth();

  const serverUrl = new URL(targetServer.url!);
  const discovered = await discoverAuth(serverUrl);
  const metadata = discovered.serverMetadata;
  if (!metadata) {
    throw new Error(`Server "${name}" does not expose OAuth metadata.`);
  }

  // DCR is only required when there is no pre-registered client (static
  // override) and no previously stored client information. Servers without a
  // registration_endpoint (e.g. GitHub) work when an "oauth.clientId"
  // override is configured.
  if (!mgr.hasStaticClient() && !(await mgr.clientInformation())) {
    if (!metadata.registration_endpoint) {
      throw new Error(
        `Server "${name}" does not support dynamic client registration. Configure an "oauth.clientId" override in mcp.json with a pre-registered client ID.`,
      );
    }
    const regResult = await registerClient(new URL(metadata.registration_endpoint), {
      metadata,
      clientMetadata: mgr.clientMetadata,
    });
    await mgr.saveClientInformation(regResult);
  }

  return metadata as NonNullable<typeof metadata>;
}

/**
 * Starts a temporary HTTP server, opens the browser for authorization,
 * and waits for the OAuth callback with a configurable timeout.
 *
 * @param mgr - OAuth credential manager.
 * @param metadata - Discovered OAuth metadata.
 * @param targetServer - Typed downstream server configuration.
 * @returns The authorization code and the full `startAuthorization` result.
 * @throws If the callback times out or the authorization is denied.
 */
async function acquireAuthorizationCode(
  mgr: import('../services/oauth.js').OAuthCredentialManager,
  metadata: OAuthMetadata,
  targetServer: DownstreamServerConfig,
  callbackPort: number,
): Promise<{
  authorizationCode: string;
  authResult: AuthResult;
}> {
  const { startAuthorization } = await _getSdkAuth();
  const { openBrowser } = await import('../utils/open-browser.js');
  const TIMEOUT_MS = _readTimeoutMs();

  return _startCallbackServerAndWait(
    mgr,
    metadata,
    targetServer,
    startAuthorization,
    openBrowser,
    TIMEOUT_MS,
    callbackPort,
  );
}

/**
 * Creates the HTTP request listener for the temporary OAuth callback server.
 *
 * Uses `tempServer` captured via closure for calling `.close()` and the
 * `resolve`/`reject` functions to settle the promise. The `timeoutHandle`
 * wrapper allows the callback to clear the timeout when a response arrives.
 *
 * @param timeoutHandle - Mutable object wrapping the timeout ID.
 * @param tempServer - The temporary HTTP server (to close on completion).
 * @param resolve - Promise resolve function.
 * @param reject - Promise reject function.
 * @returns An HTTP request listener.
 */
function _makeCallbackHandler(
  timeoutHandle: { current: ReturnType<typeof setTimeout> | undefined },
  tempServer: import('node:http').Server,
  resolve: (code: string) => void,
  reject: (err: Error) => void,
): import('node:http').RequestListener {
  return (req, res) => {
    const url = new URL(req.url!, `http://localhost`);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (code) {
      if (timeoutHandle.current) clearTimeout(timeoutHandle.current);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body><h1>Authorization successful!</h1><p>You can close this window.</p></body></html>',
      );
      tempServer.close();
      resolve(code);
    } else if (error) {
      if (timeoutHandle.current) clearTimeout(timeoutHandle.current);
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<html><body><h1>Authorization failed</h1><p>${error}</p></body></html>`);
      tempServer.close();
      reject(new Error(`Authorization failed: ${error}`));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  };
}

/** Creates a temp HTTP server, starts OAuth flow, waits for callback. */
async function _startCallbackServerAndWait(
  mgr: import('../services/oauth.js').OAuthCredentialManager,
  metadata: OAuthMetadata,
  targetServer: DownstreamServerConfig,
  startAuthorization: Awaited<ReturnType<typeof _getSdkAuth>>['startAuthorization'],
  openBrowser: (url: string) => Promise<void>,
  TIMEOUT_MS: number,
  callbackPort: number,
): Promise<{
  authorizationCode: string;
  authResult: AuthResult;
}> {
  const http = await import('node:http');
  const timeoutHandle: {
    current: ReturnType<typeof setTimeout> | undefined;
  } = { current: undefined };

  const authResultRef: {
    value: Awaited<ReturnType<typeof startAuthorization>> | undefined;
  } = { value: undefined };

  const authorizationCode = await new Promise<string>((resolve, reject) => {
    const tempServer = http.createServer();
    tempServer.on('request', _makeCallbackHandler(timeoutHandle, tempServer, resolve, reject));

    tempServer.listen(
      callbackPort,
      _onServerListen(
        tempServer,
        mgr,
        metadata,
        targetServer,
        startAuthorization,
        openBrowser,
        TIMEOUT_MS,
        timeoutHandle,
        authResultRef,
        reject,
      ),
    );

    tempServer.on('error', (err) => {
      if (timeoutHandle.current) clearTimeout(timeoutHandle.current);
      reject(err);
    });
  });

  if (timeoutHandle.current) clearTimeout(timeoutHandle.current);

  return { authorizationCode, authResult: authResultRef.value! };
}

/** Listen callback: sets port, starts auth, opens browser, arms timeout. */
function _onServerListen(
  tempServer: import('node:http').Server,
  mgr: import('../services/oauth.js').OAuthCredentialManager,
  metadata: OAuthMetadata,
  targetServer: DownstreamServerConfig,
  startAuthorization: Awaited<ReturnType<typeof _getSdkAuth>>['startAuthorization'],
  openBrowser: (url: string) => Promise<void>,
  TIMEOUT_MS: number,
  timeoutHandle: { current: ReturnType<typeof setTimeout> | undefined },
  authResultRef: { value: AuthResult | undefined },
  reject: (err: Error) => void,
): () => Promise<void> {
  return async () => {
    try {
      const address = tempServer.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      const actualPort = address.port;

      mgr.setActualPort(actualPort);

      authResultRef.value = await startAuthorization(new URL(metadata.authorization_endpoint!), {
        metadata,
        clientInformation: (await mgr.clientInformation())!,
        redirectUrl: mgr.redirectUrl as string,
        scope: targetServer.oauth?.scope,
      });

      await mgr.saveCodeVerifier(authResultRef.value.codeVerifier);

      void openBrowser(authResultRef.value.authorizationUrl.toString());

      timeoutHandle.current = setTimeout(() => {
        tempServer.close();
        reject(
          new Error(`OAuth login timed out after ${TIMEOUT_MS / 1000} seconds. Please try again.`),
        );
      }, TIMEOUT_MS);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
}

/**
 * Reads the OAuth login timeout from the
 * `MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS` env var, defaulting to 120 seconds.
 *
 * @returns Timeout in milliseconds.
 */
function _readTimeoutMs(): number {
  const env = process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS;
  if (env) {
    const parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 120_000;
}

/**
 * Validates a requested callback port override from the `--port` flag.
 *
 * @param port - The raw port value (0 means "OS-assigned", undefined
 *   means "use config or OS-assigned").
 * @returns The validated port number (0 or a positive integer
 *   1-65535), or undefined when no override was given.
 * @throws If the port is not a valid integer in range.
 */
function _validatePortOverride(port: number | undefined): number | undefined {
  if (port === undefined) {
    return undefined;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `--port must be an integer between 0 and 65535 (got ${port}). Use 0 to let the OS assign a port.`,
    );
  }
  return port;
}

/**
 * Resolves the effective callback port from the `--port` override, the
 * server's `oauth.callbackPort` config field, or 0 (OS-assigned) as a
 * final fallback.
 *
 * @param override - The validated `--port` override, or undefined.
 * @param server - The typed downstream server configuration.
 * @returns The port to bind the callback server on (0 = OS-assigned).
 */
function _resolveCallbackPort(
  override: number | undefined,
  server: DownstreamServerConfig,
): number {
  if (override !== undefined) {
    return override;
  }
  return server.oauth?.callbackPort ?? 0;
}

/**
 * Handles the `login <name>` subcommand.
 *
 * Validates the server exists in config and is an HTTP type.
 * For HTTP servers, runs the OAuth authorization-code flow
 * using the SDK's OAuth client infrastructure. The flow opens
 * a browser, handles the redirect callback, exchanges the
 * authorization code for tokens, and persists them in credentials.json.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name to authenticate.
 * @param portOverride - Optional `--port` override for the local
 *   callback server. 0 forces an OS-assigned port; a positive integer
 *   binds to that exact port (overrides `oauth.callbackPort`). When
 *   omitted, `oauth.callbackPort` from config is used, falling back to
 *   an OS-assigned port.
 * @returns Human-readable confirmation message.
 * @throws If the server name is not found or is not an HTTP type.
 */
export async function handleLogin(
  configPath: string,
  name: string,
  portOverride?: number,
): Promise<string> {
  const { targetServer } = await validateServerForLogin(configPath, name);

  const callbackPort = _resolveCallbackPort(_validatePortOverride(portOverride), targetServer);

  const { OAuthCredentialManager } = await import('../services/oauth.js');
  const mgr = new OAuthCredentialManager(configPath, targetServer);

  const metadata = await setupOAuthClient(mgr, targetServer, name);

  const { authorizationCode, authResult } = await acquireAuthorizationCode(
    mgr,
    metadata,
    targetServer,
    callbackPort,
  );

  const { exchangeAuthorization } = await _getSdkAuth();

  const realRedirectUrl = mgr.redirectUrl as string;
  const tokens = await exchangeAuthorization(new URL(metadata.token_endpoint!), {
    metadata,
    clientInformation: (await mgr.clientInformation())!,
    authorizationCode,
    codeVerifier: authResult.codeVerifier,
    redirectUri: realRedirectUrl,
  });

  await mgr.saveTokens(tokens);

  return `Successfully authenticated server "${name}". Tokens stored in credentials.json.`;
}
