import {
  refreshAuthorization,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { DownstreamServerConfig, Logger, StoredCredentials } from '../utils/index.js';
import { readCredentials, writeCredentials, removeCredentials } from '../cli/config-io.js';
import { discoverAuth } from './oauth-discovery.js';
import { GuidedAuthError } from './index.js';

/**
 * How long before expiry a token is considered due for proactive
 * refresh, in milliseconds. A refresh is triggered when the token's
 * absolute `expires_at` is within this window of (or already past)
 * the current time. Keeps a small safety margin so the token does
 * not expire in the gap between the refresh check and the request.
 */
const REFRESH_BUFFER_MS = 60_000;

/**
 * Computes the absolute ISO-8601 expiry timestamp from a relative
 * `expires_in` (seconds from now). Returns `undefined` when the TTL
 * is absent or non-finite, so callers can skip proactive refresh for
 * tokens that never expire or carry no expiry information.
 *
 * @param expiresIn - Token lifetime in seconds, or undefined.
 * @returns Absolute expiry timestamp, or undefined.
 */
function computeExpiresAt(expiresIn: number | undefined): string | undefined {
  if (expiresIn === undefined || !Number.isFinite(expiresIn)) {
    return undefined;
  }
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

/**
 * Determines whether a token with the given absolute expiry is due for
 * proactive refresh. Returns true when the token is already expired or
 * will expire within {@link REFRESH_BUFFER_MS}.
 *
 * @param expiresAtIso - ISO-8601 expiry timestamp.
 * @returns True when the token should be refreshed now.
 */
function needsRefresh(expiresAtIso: string): boolean {
  const expiresAtMs = Date.parse(expiresAtIso);
  if (Number.isNaN(expiresAtMs)) {
    return false;
  }
  return expiresAtMs - Date.now() <= REFRESH_BUFFER_MS;
}

/**
 * The OAuth redirect callback path served by the temporary local HTTP
 * server started during `login`. The full redirect URI is
 * `http://localhost:<port>/mcp-compress-router/oauth-callback`, where
 * `<port>` is assigned by the OS. Register this path (on `localhost`,
 * any port) with OAuth providers that require a pre-registered client.
 *
 * @internal Exported for tests only; not part of the public module API.
 *   The constant is consumed internally by `redirectUrl`; tests import
 *   it directly to avoid hardcoding the path string.
 */
export const OAUTH_CALLBACK_PATH = '/mcp-compress-router/oauth-callback';

/**
 * Implements OAuthClientProvider backed by credentials.json credential storage.
 *
 * Each instance manages credentials for one downstream server.
 * When `oauth` overrides are present in the server config, dynamic
 * client registration is skipped and static client info is used.
 */
export class OAuthCredentialManager implements OAuthClientProvider {
  private readonly _configPath: string;
  private readonly _server: DownstreamServerConfig;
  private _codeVerifier?: string;
  private _staticClientInfo?: OAuthClientInformationMixed;
  private _actualPort: number = 0;
  /**
   * In-flight proactive refresh promise. When set, concurrent
   * callers of {@link refreshIfNeeded} await this shared promise
   * instead of triggering duplicate refresh requests.
   */
  private _refreshInFlight?: Promise<void>;

  constructor(configPath: string, server: DownstreamServerConfig) {
    this._configPath = configPath;
    this._server = server;

    // If oauth overrides are present, set up static client info
    if (server.oauth?.clientId) {
      const info: OAuthClientInformationMixed = {
        client_id: server.oauth.clientId,
      };
      if (server.oauth.clientSecret) {
        info.client_secret = server.oauth.clientSecret;
      }
      this._staticClientInfo = info;
    }
  }

  get redirectUrl(): string | URL | undefined {
    // Return the callback URL with the actual port assigned by the OS.
    // Falls back to port 0 until setActualPort() is called by login-command.
    return `http://localhost:${this._actualPort}${OAUTH_CALLBACK_PATH}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl as string],
      client_name: 'mcp-compress-router',
    };
  }

  /**
   * Sets the actual listening port of the temporary HTTP callback server.
   * Must be called before startAuthorization so the redirect_uri is correct.
   *
   * @param port - The actual port the callback server is listening on.
   */
  setActualPort(port: number): void {
    this._actualPort = port;
  }

  /**
   * Whether this manager has static (override) client information,
   * bypassing dynamic client registration.
   */
  hasStaticClient(): boolean {
    return this._staticClientInfo !== undefined;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    // Static overrides take precedence
    if (this._staticClientInfo) {
      return this._staticClientInfo;
    }
    const creds = await this._loadCredentials();
    return creds?.clientRegistration as OAuthClientInformationMixed | undefined;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    if (this._staticClientInfo) {
      // Don't overwrite static overrides
      return;
    }
    const creds = await this._loadCredentials();
    const updated: StoredCredentials = {
      clientRegistration: clientInformation as Record<string, unknown>,
      // Preserve existing tokens; omit when none (tokens is optional).
      ...(creds?.tokens ? { tokens: creds.tokens } : {}),
      // Successful OAuth client registration proves the server supports
      // OAuth. Override any stale cached requirement.
      authRequirement: 'oauth',
      checkedAt: new Date().toISOString(),
    };
    await writeCredentials(this._configPath, this._server.name, updated);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const creds = await this._loadCredentials();
    if (!creds?.tokens?.access_token) {
      return undefined;
    }
    return creds.tokens as OAuthTokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const creds = await this._loadCredentials();
    const updated: StoredCredentials = {
      clientRegistration: creds?.clientRegistration,
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        expires_at: computeExpiresAt(tokens.expires_in),
        scope: tokens.scope,
        token_type: tokens.token_type,
      },
      // A successful OAuth token exchange proves the server supports
      // OAuth. Override any stale cached requirement (e.g. 'none' from
      // a failed startup probe) with 'oauth'.
      authRequirement: 'oauth',
      checkedAt: new Date().toISOString(),
    };
    await writeCredentials(this._configPath, this._server.name, updated);
  }

  /**
   * Called by the SDK's `auth()` flow when an access token cannot be
   * obtained or refreshed and interactive authorization is required.
   *
   * Always throws {@link GuidedAuthError}: interactive authorization
   * cannot be completed from the running router. Callers use the
   * tagged error to discriminate auth failures from other errors.
   *
   * @param _authorizationUrl - The authorization URL the SDK built.
   *   Unused — kept for interface conformance.
   * @throws Always — {@link GuidedAuthError}.
   */
  async redirectToAuthorization(_authorizationUrl: URL): Promise<void> {
    throw new GuidedAuthError(this._server.name);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this._codeVerifier = codeVerifier;
  }

  async codeVerifier(): Promise<string> {
    if (!this._codeVerifier) {
      throw new Error('No code verifier saved');
    }
    return this._codeVerifier;
  }

  /**
   * Removes stored OAuth tokens and client registration for this server
   * (used by logout). Preserves the cached auth requirement so the
   * `list` command still shows the correct status (e.g. "requires
   * login") after logout. When there is no cached auth requirement to
   * keep, the entire entry is removed (and the credentials file deleted
   * when it becomes empty).
   */
  async clearTokens(): Promise<void> {
    this._codeVerifier = undefined;
    const creds = await this._loadCredentials();
    if (creds?.authRequirement) {
      await writeCredentials(this._configPath, this._server.name, {
        authRequirement: creds.authRequirement,
        checkedAt: creds.checkedAt,
      });
      return;
    }
    await removeCredentials(this._configPath, this._server.name);
  }

  /**
   * Invalidates stored credentials for this server in the scope the
   * SDK requests after a token request fails with a recoverable OAuth
   * error. Implements the {@link OAuthClientProvider.invalidateCredentials}
   * optional hook so the SDK can clear stale state before retrying
   * the authorization flow.
   *
   * - `'all'` — clears tokens AND client registration. The next
   *   attempt re-registers and re-authorizes. Delegates to
   *   {@link clearTokens} so the cached auth-requirement probe is
   *   preserved (the server still requires OAuth).
   * - `'client'` — clears only the client registration, preserving
   *   tokens and the auth-requirement cache.
   * - `'tokens'` — clears only the stored tokens, preserving client
   *   registration (so the next login can reuse dynamic registration)
   *   and the auth-requirement cache.
   * - `'verifier'` — clears the in-memory PKCE code verifier only
   *   (never persisted, so no disk write).
   *
   * @param scope - Which credentials to invalidate.
   */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    if (scope === 'verifier') {
      this._codeVerifier = undefined;
      return;
    }
    if (scope === 'all') {
      await this.clearTokens();
      return;
    }
    const creds = await this._loadCredentials();
    if (!creds) {
      return;
    }
    const remaining: StoredCredentials = {
      clientRegistration: scope === 'client' ? undefined : creds.clientRegistration,
      tokens: scope === 'tokens' ? undefined : creds.tokens,
      authRequirement: creds.authRequirement,
      checkedAt: creds.checkedAt,
    };
    // Drop the entry entirely when nothing credential-like or
    // probe-related remains, mirroring clearTokens' cleanup.
    if (
      remaining.clientRegistration === undefined &&
      remaining.tokens === undefined &&
      remaining.authRequirement === undefined
    ) {
      await removeCredentials(this._configPath, this._server.name);
      return;
    }
    await writeCredentials(this._configPath, this._server.name, remaining);
  }

  /**
   * Proactively refreshes the access token when it is near or past
   * expiry, so the downstream request goes out with a valid token
   * instead of incurring a wasted 401 round-trip. Called by the
   * router before each tool invocation.
   *
   * This is best-effort: when there are no tokens, no refresh token,
   * no recorded expiry, or the refresh attempt fails, it returns
   * without throwing. The SDK's reactive 401 refresh path remains the
   * fallback when proactive refresh cannot proceed. Concurrent callers
   * share a single in-flight refresh to avoid duplicate token
   * requests.
   *
   * @param logger - Optional structured logger; when provided, refresh
   *   failures are logged at error level so they are visible without
   *   a separate 401 fallback. Without a logger, failures are silent.
   */
  async refreshIfNeeded(logger?: Logger): Promise<void> {
    if (this._refreshInFlight) {
      await this._refreshInFlight;
      return;
    }
    // Claim the slot synchronously so concurrent callers wait on the
    // same promise rather than racing duplicate refreshes.
    this._refreshInFlight = this._runRefreshIfNeeded(logger).finally(() => {
      this._refreshInFlight = undefined;
    });
    await this._refreshInFlight;
  }

  private async _runRefreshIfNeeded(logger?: Logger): Promise<void> {
    const stored = await this._loadCredentials();
    const tokens = stored?.tokens;
    if (!tokens?.refresh_token || !tokens.expires_at) {
      return;
    }
    if (!needsRefresh(tokens.expires_at)) {
      return;
    }
    await this._refreshTokens(tokens.refresh_token, logger);
  }

  /**
   * Performs the token refresh: discovers the authorization server
   * metadata, calls the SDK's `refreshAuthorization`, and persists the
   * refreshed tokens via {@link saveTokens} (which recomputes
   * `expires_at`). Errors are logged (when a logger is supplied) and
   * swallowed — proactive refresh is best-effort; the SDK's 401 path
   * handles terminal failures.
   */
  private async _refreshTokens(refreshToken: string, logger?: Logger): Promise<void> {
    try {
      if (!this._server.url) {
        return;
      }
      const discovered = await discoverAuth(new URL(this._server.url));
      if (!discovered.serverMetadata) {
        return;
      }
      const clientInformation = await this.clientInformation();
      if (!clientInformation) {
        return;
      }
      const newTokens = await refreshAuthorization(discovered.authorizationServerUrl, {
        metadata: discovered.serverMetadata,
        clientInformation,
        refreshToken,
      });
      await this.saveTokens(newTokens);
    } catch (err) {
      // Proactive refresh is best-effort; the SDK's reactive 401
      // path (auth()) is the fallback for terminal failures. Log
      // the error when a logger is available so the failure is
      // visible without waiting for the 401.
      if (logger) {
        logger.error('Proactive OAuth token refresh failed', {
          server: this._server.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async _loadCredentials(): Promise<StoredCredentials | undefined> {
    const all = await readCredentials(this._configPath);
    return all[this._server.name];
  }
}
