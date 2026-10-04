import type { DownstreamServerConfig } from '../utils/index.js';
import { Logger, validateOAuthClientName, validateOAuthClientUri } from '../utils/index.js';
import { ensureConfigDir, readConfigFile, type RawServerEntry } from './config-io.js';
import { loadConfig } from '../services/config.js';
import { discoverAuth, discoverSingleServer, saveToolCache } from '../services/index.js';
import { OAUTH_LOOPBACK_URI, OAuthCredentialManager } from '../services/oauth.js';
import type {
  OAuthClientInformationMixed,
  OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { acquireAuthorizationCode, type AuthResult } from './login-callback-server.js';
import { createPasteReader, type PasteReader } from './login-paste.js';

/** SDK OAuth metadata type (non-null after discovery). */
type OAuthMetadata = NonNullable<
  Awaited<
    ReturnType<
      typeof import('@modelcontextprotocol/sdk/client/auth.js').discoverAuthorizationServerMetadata
    >
  >
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

// Cached lazy import for the browser launcher.
let _openBrowser: ((url: string) => Promise<void>) | undefined;

/**
 * Returns the browser launcher, loading the module on first use.
 *
 * @returns The `openBrowser` function.
 */
async function _getOpenBrowser(): Promise<(url: string) => Promise<void>> {
  if (!_openBrowser) {
    _openBrowser = (await import('../utils/open-browser.js')).openBrowser;
  }
  return _openBrowser;
}

/**
 * Discovers the OAuth authorization server metadata for a server.
 *
 * @param targetServer - Typed downstream server configuration.
 * @param name - Server name (for error messages).
 * @returns The discovered OAuth metadata, whether the authorization
 *   server commits to the RFC 9207 `iss` parameter (read from the raw
 *   metadata document, so it also covers OpenID Connect discovery),
 *   and the RFC 9728 Protected Resource Metadata when the server
 *   publishes it (used to derive the RFC 8707 `resource` indicator).
 * @throws If the server does not expose OAuth metadata.
 */
async function discoverOAuthMetadata(
  targetServer: DownstreamServerConfig,
  name: string,
): Promise<{
  metadata: OAuthMetadata;
  requireIssuer: boolean;
  resourceMetadata?: OAuthProtectedResourceMetadata;
}> {
  const serverUrl = new URL(targetServer.url!);
  const discovered = await discoverAuth(serverUrl);
  const metadata = discovered.serverMetadata;
  if (!metadata) {
    throw new Error(`Server "${name}" does not expose OAuth metadata.`);
  }
  return {
    metadata: metadata as NonNullable<typeof metadata>,
    requireIssuer: discovered.authorizationResponseIssParameterSupported,
    resourceMetadata: discovered.resourceMetadata,
  };
}

/**
 * Whether a stored client registration covers the portless loopback
 * redirect URI. The comparison ignores the port (RFC 8252 §8.4 excludes
 * it from loopback redirect matching) but requires the scheme, host, and
 * path to match, so a registration for a different host (e.g.
 * `localhost`) is not reused.
 *
 * @param client - The stored client registration.
 * @returns True when at least one registered redirect URI matches
 *   {@link OAUTH_LOOPBACK_URI} ignoring the port.
 */
function _registrationCoversLoopback(client: OAuthClientInformationMixed): boolean {
  if (!('redirect_uris' in client) || client.redirect_uris.length === 0) {
    return false;
  }
  const expected = new URL(OAUTH_LOOPBACK_URI);
  return client.redirect_uris.some((entry) => {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      return false;
    }
    return (
      parsed.protocol === expected.protocol &&
      parsed.hostname === expected.hostname &&
      parsed.pathname === expected.pathname
    );
  });
}

/**
 * Whether a stored client registration can be reused for this login.
 *
 * The registered redirect URIs must cover the portless loopback callback
 * URI (see {@link _registrationCoversLoopback}). When the server
 * configures a `client_name` or `client_uri` override, the stored
 * registration must carry the same value for that field. Identity fields
 * the stored registration does not contain are ignored: legacy
 * registrations (and providers that do not echo the metadata) stay
 * reusable instead of being re-registered on every login.
 *
 * @param client - The stored client registration.
 * @param server - The effective downstream server configuration.
 * @returns True when the stored registration can be reused as-is.
 */
function _registrationMatches(
  client: OAuthClientInformationMixed,
  server: DownstreamServerConfig,
): boolean {
  if (!_registrationCoversLoopback(client)) {
    return false;
  }
  const { clientName, clientUri } = server.oauth ?? {};
  if (clientName !== undefined && 'client_name' in client && client.client_name !== clientName) {
    return false;
  }
  if (clientUri !== undefined && 'client_uri' in client && client.client_uri !== clientUri) {
    return false;
  }
  return true;
}

/**
 * Registers a client through dynamic client registration (RFC 7591) unless
 * a static `oauth.clientId` override is configured or a stored registration
 * matches the loopback redirect URI and the configured client identity.
 * Registration does not depend on the callback port: the registered URI is
 * the portless {@link OAUTH_LOOPBACK_URI}, and RFC 8252 §8.4 excludes the
 * port from loopback redirect matching.
 *
 * @param mgr - OAuth credential manager for the target server.
 * @param metadata - Discovered OAuth metadata.
 * @param name - Server name (for error messages).
 * @param server - The effective downstream server configuration (config
 *   plus any `login` overrides), used for the identity comparison.
 * @throws If the server does not support dynamic client registration and no
 *   reusable registration or static client is available.
 */
async function registerClientIfNeeded(
  mgr: OAuthCredentialManager,
  metadata: OAuthMetadata,
  name: string,
  server: DownstreamServerConfig,
): Promise<void> {
  if (mgr.hasStaticClient()) {
    return;
  }
  const stored = await mgr.clientInformation();
  if (stored && _registrationMatches(stored, server)) {
    return;
  }
  if (!metadata.registration_endpoint) {
    throw new Error(
      `Server "${name}" does not support dynamic client registration. Configure an "oauth.clientId" override in mcp.json with a pre-registered client ID.`,
    );
  }
  const { registerClient } = await _getSdkAuth();
  const registration = await registerClient(new URL(metadata.registration_endpoint), {
    metadata,
    clientMetadata: mgr.clientMetadata,
  });
  await mgr.saveClientInformation(registration);
}

/**
 * Registers the client if needed and builds the authorization URL. Passed to
 * the callback server as its post-listen hook, so it runs once the real
 * callback port is known and the authorization request carries it.
 *
 * @param mgr - OAuth credential manager for the target server.
 * @param metadata - Discovered OAuth metadata.
 * @param targetServer - Typed downstream server configuration.
 * @param name - Server name (for error messages).
 * @param state - CSRF state generated for this login attempt.
 * @param resource - RFC 8707 resource indicator selected from the
 *   server's Protected Resource Metadata, or undefined when the server
 *   publishes none (the SDK then omits the `resource` parameter).
 * @returns The `startAuthorization` result.
 */
async function beginAuthorization(
  mgr: OAuthCredentialManager,
  metadata: OAuthMetadata,
  targetServer: DownstreamServerConfig,
  name: string,
  state: string,
  resource: URL | undefined,
): Promise<AuthResult> {
  await registerClientIfNeeded(mgr, metadata, name, targetServer);
  const { startAuthorization } = await _getSdkAuth();
  return startAuthorization(new URL(metadata.authorization_endpoint!), {
    metadata,
    clientInformation: (await mgr.clientInformation())!,
    redirectUrl: mgr.redirectUrl as string,
    scope: targetServer.oauth?.scope,
    state,
    resource,
  });
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
 * Applies the `--client-name` / `--client-uri` overrides on top of the
 * server's configured `oauth` block. The returned configuration is used
 * for this login only; the flags are not persisted (matching `--port`).
 * Each override is validated before any network activity.
 *
 * @param server - The typed downstream server configuration.
 * @param options - Login options carrying the overrides.
 * @returns The effective server configuration.
 * @throws If an override is invalid (empty name or non-http(s) URI).
 */
function _applyOAuthOverrides(
  server: DownstreamServerConfig,
  options: LoginOptions | undefined,
): DownstreamServerConfig {
  const clientName =
    options?.clientNameOverride !== undefined
      ? validateOAuthClientName(options.clientNameOverride, '--client-name')
      : undefined;
  const clientUri =
    options?.clientUriOverride !== undefined
      ? validateOAuthClientUri(options.clientUriOverride, '--client-uri')
      : undefined;
  if (clientName === undefined && clientUri === undefined) {
    return server;
  }
  return {
    ...server,
    oauth: {
      ...server.oauth,
      ...(clientName !== undefined ? { clientName } : {}),
      ...(clientUri !== undefined ? { clientUri } : {}),
    },
  };
}

/**
 * Options for the `login` subcommand.
 */
export interface LoginOptions {
  /**
   * Optional `--port` override for the local callback server. 0 forces
   * an OS-assigned port; a positive integer binds to that exact port
   * (overrides `oauth.callbackPort`). When omitted,
   * `oauth.callbackPort` from config is used, falling back to an
   * OS-assigned port.
   */
  portOverride?: number;
  /**
   * Optional `--client-name` override for dynamic client registration.
   * Overrides `oauth.clientName` for this login only; not persisted.
   * Must be a non-empty string.
   */
  clientNameOverride?: string;
  /**
   * Optional `--client-uri` override for dynamic client registration.
   * Overrides `oauth.clientUri` for this login only; not persisted.
   * Must be an absolute http(s) URL.
   */
  clientUriOverride?: string;
  /**
   * Set by `--no-browser`: print the authorization URL and read a
   * pasted redirect URL or authorization code from stdin instead of
   * opening a browser.
   */
  noBrowser?: boolean;
}

/**
 * Creates the lazy manual reader used by the paste fallback. The reader
 * is created only when the manual path starts, so a normal browser
 * login never touches stdin; `close` releases it afterwards so an idle
 * interface cannot keep the CLI process alive.
 *
 * @returns The reader provider and its close function.
 */
function _createManualReader(): {
  getManualReader: () => Pick<PasteReader, 'readLine'> | undefined;
  close: () => void;
} {
  let reader: PasteReader | undefined;
  return {
    getManualReader: () => {
      reader ??= createPasteReader();
      return reader;
    },
    close: () => {
      reader?.close();
    },
  };
}

/**
 * Handles the `login <name>` subcommand.
 *
 * Validates the server exists in config and is an HTTP type.
 * For HTTP servers, runs the OAuth authorization-code flow
 * using the SDK's OAuth client infrastructure. The flow binds a
 * temporary loopback callback server, registers the client (when
 * needed) with the portless loopback callback URI, prints the
 * authorization URL, opens a browser (unless `noBrowser` is set),
 * accepts either the redirect callback or a pasted redirect URL or
 * authorization code, exchanges the code for tokens, and persists them
 * in credentials.json. The authorization and token requests carry the
 * RFC 8707 `resource` indicator derived from the server's Protected
 * Resource Metadata when it publishes one. The `--client-name` and
 * `--client-uri` overrides replace the configured `oauth.clientName` /
 * `oauth.clientUri` for this login only and are not persisted.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name to authenticate.
 * @param options - Optional login options.
 * @returns Human-readable confirmation message.
 * @throws If the server name is not found or is not an HTTP type.
 */
export async function handleLogin(
  configPath: string,
  name: string,
  options?: LoginOptions,
): Promise<string> {
  const { targetServer } = await validateServerForLogin(configPath, name);
  const effectiveServer = _applyOAuthOverrides(targetServer, options);

  const callbackPort = _resolveCallbackPort(
    _validatePortOverride(options?.portOverride),
    effectiveServer,
  );

  const mgr = new OAuthCredentialManager(configPath, effectiveServer);

  const { metadata, requireIssuer, resourceMetadata } = await discoverOAuthMetadata(
    effectiveServer,
    name,
  );

  // Bind any stored credentials to the authorization server that
  // actually serves this login: a registration or token obtained from a
  // different issuer must not be reused.
  mgr.setIssuer(metadata.issuer);

  const { selectResourceURL, exchangeAuthorization } = await _getSdkAuth();

  // RFC 8707 resource indicator, selected from the server's Protected
  // Resource Metadata the same way the SDK's auth() flow selects it.
  // Undefined when the server publishes no such metadata: the SDK then
  // omits the parameter, matching the runtime transport path.
  const resource = await selectResourceURL(new URL(effectiveServer.url!), mgr, resourceMetadata);

  const manualReader = _createManualReader();
  const { authorizationCode, authResult } = await acquireAuthorizationCode({
    mgr,
    callbackPort,
    openBrowser: await _getOpenBrowser(),
    expectedIssuer: metadata.issuer,
    requireIssuer,
    noBrowser: options?.noBrowser,
    getManualReader: manualReader.getManualReader,
    beginAuthorization: (state) =>
      beginAuthorization(mgr, metadata, effectiveServer, name, state, resource),
  }).finally(manualReader.close);

  const realRedirectUrl = mgr.redirectUrl as string;
  const tokens = await exchangeAuthorization(new URL(metadata.token_endpoint!), {
    metadata,
    clientInformation: (await mgr.clientInformation())!,
    authorizationCode,
    codeVerifier: authResult.codeVerifier,
    redirectUri: realRedirectUrl,
    resource,
  });

  await mgr.saveTokens(tokens);
  await _cacheToolsAfterLogin(configPath, name, effectiveServer, mgr);

  return `Successfully authenticated server "${name}". Tokens stored in credentials.json.`;
}

/**
 * Best-effort tool discovery after a successful login: saves the fresh
 * tool list to the cache so the next router startup (or self-recovery)
 * has an up-to-date cache. Failures are ignored — the tokens are already
 * stored, and the cache refreshes on the next router startup.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name.
 * @param server - The effective downstream server configuration.
 * @param mgr - OAuth credential manager holding the fresh tokens.
 */
async function _cacheToolsAfterLogin(
  configPath: string,
  name: string,
  server: DownstreamServerConfig,
  mgr: OAuthCredentialManager,
): Promise<void> {
  try {
    const logger = new Logger('error');
    const discovered = await discoverSingleServer(server, logger, () => mgr);
    await saveToolCache(configPath, name, discovered.tools);
  } catch {
    // Best-effort — tokens are saved, cache will refresh on next
    // router startup.
  }
}
