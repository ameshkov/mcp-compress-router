import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { DownstreamServerConfig, Logger, StoredCredentials } from '../utils/index.js';
import { mutateCredentials, readCredentials, withRefreshLock } from '../cli/config-io.js';
import { bindingFieldsFor, credentialsUsableFor } from './credential-binding.js';
import {
  computeExpiresAt,
  dueRefreshToken,
  requestTokenRefresh,
  tokensNeedInvalidation,
} from './oauth-token-refresh.js';
import { GuidedAuthError } from './index.js';

/**
 * Base auth-failure backoff window, in milliseconds. After a 401
 * survives an adopted or freshly refreshed access token, the provider
 * refuses further refreshes for a jittered multiple of this window so
 * a server that keeps rejecting tokens cannot drive a refresh loop.
 *
 * @internal Exported for tests only; not part of the public module API.
 */
export const AUTH_FAILURE_COOLDOWN_MS = 30_000;

/**
 * Relative jitter applied to {@link AUTH_FAILURE_COOLDOWN_MS}, as a
 * fraction of the base window (±20 %). The jitter spreads the backoff
 * deadlines of concurrent router instances so they do not retry a
 * failing server in lockstep.
 *
 * @internal Exported for tests only; not part of the public module API.
 */
export const AUTH_FAILURE_COOLDOWN_JITTER = 0.2;

/**
 * The OAuth redirect callback path served by the temporary local HTTP
 * server started during `login`. The authorization-request redirect URI
 * is `http://127.0.0.1:<port>/mcp-compress-router/oauth-callback`, where
 * `<port>` is assigned by the OS. Register this path (on the loopback
 * interface, any port) with OAuth providers that require a pre-registered
 * client.
 *
 * @internal Exported for tests only; not part of the public module API.
 *   The constant is consumed internally by `redirectUrl` and
 *   `OAUTH_LOOPBACK_URI`; tests import it directly to avoid hardcoding
 *   the path string.
 */
export const OAUTH_CALLBACK_PATH = '/mcp-compress-router/oauth-callback';

/**
 * The loopback redirect URI registered with OAuth providers through
 * dynamic client registration. It carries no port: RFC 8252 §8.4
 * excludes the port from loopback redirect matching, so one registration
 * stays valid across logins no matter which port the callback server
 * binds. The authorization request and the token exchange use
 * {@link OAuthCredentialManager.redirectUrl} instead, which carries the
 * actual port.
 */
export const OAUTH_LOOPBACK_URI = `http://127.0.0.1${OAUTH_CALLBACK_PATH}`;

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
   * Authorization server issuer recorded for the current flow, when
   * discovered. Stamped onto saved credentials and used to reject a
   * stored entry obtained from a different authorization server.
   */
  private _issuer?: string;
  /**
   * In-flight proactive refresh promise. When set, concurrent
   * callers of {@link refreshIfNeeded} await this shared promise
   * instead of triggering duplicate refresh requests.
   */
  private _refreshInFlight?: Promise<void>;
  /**
   * In-flight coordinated 401 refresh promise. When set, concurrent
   * callers of {@link refreshAfterUnauthorized} await this shared
   * attempt instead of racing duplicate adopt/refresh requests.
   */
  private _authRefreshInFlight?: Promise<OAuthTokens | undefined>;
  /**
   * Wall-clock deadline (epoch milliseconds) until which refreshes are
   * refused after a 401 survived an adopted or freshly refreshed token.
   * Zero means no backoff is active.
   */
  private _authFailureUntil = 0;

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

  /**
   * The redirect URI sent with the authorization request and with the
   * token exchange. Carries the actual port assigned by the OS (0 until
   * {@link setActualPort} is called); both requests must send the same
   * value (RFC 6749 §4.1.3). Dynamic client registration does not use
   * it — the registered URI is the portless {@link OAUTH_LOOPBACK_URI}.
   */
  get redirectUrl(): string | URL | undefined {
    return `http://127.0.0.1:${this._actualPort}${OAUTH_CALLBACK_PATH}`;
  }

  /**
   * The configured name of the downstream server this manager serves,
   * used to attribute auth-retry and backoff log records.
   */
  get serverName(): string {
    return this._server.name;
  }

  /**
   * Client metadata used for dynamic client registration. The registered
   * redirect URI is the portless loopback form
   * ({@link OAUTH_LOOPBACK_URI}): RFC 8252 §8.4 excludes the port from
   * loopback redirect matching, so the registration stays valid across
   * logins regardless of the port the callback server binds.
   *
   * `client_name` defaults to `mcp-compress-router` and can be overridden
   * per server with `oauth.clientName`; `client_uri` is omitted unless
   * `oauth.clientUri` is configured. Providers that allowlist client
   * identities (e.g. Figma) gate dynamic client registration on these
   * fields, so both the CLI login flow and the SDK's runtime `auth()`
   * flow read the effective values here.
   *
   * `application_type` is required for native clients by the MCP
   * authorization specification (and by OIDC-aware registration
   * endpoints, which otherwise default to "web"). The SDK's
   * OAuthClientMetadata type does not declare it yet, so the return
   * type widens explicitly; the SDK spreads this object into the
   * registration body unchanged, so the field reaches the server.
   */
  get clientMetadata(): OAuthClientMetadata & { application_type: 'native' } {
    const metadata: OAuthClientMetadata & { application_type: 'native' } = {
      redirect_uris: [OAUTH_LOOPBACK_URI],
      client_name: this._server.oauth?.clientName ?? 'mcp-compress-router',
      application_type: 'native',
    };
    if (this._server.oauth?.clientUri !== undefined) {
      metadata.client_uri = this._server.oauth.clientUri;
    }
    return metadata;
  }

  /**
   * Sets the actual listening port of the temporary HTTP callback server.
   * Must be called before startAuthorization so the authorization request
   * (and the token exchange that follows it) carries the correct
   * redirect_uri. Dynamic client registration does not depend on it: the
   * registered URI is the portless {@link OAUTH_LOOPBACK_URI}.
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

  /**
   * Records the discovered authorization server issuer for the current
   * flow. Saved credentials are stamped with it, and a stored entry
   * whose recorded issuer differs is not reused.
   *
   * @param issuer - The authorization server issuer from RFC 8414 /
   *   OIDC metadata.
   */
  setIssuer(issuer: string): void {
    this._issuer = issuer;
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
    await mutateCredentials(this._configPath, this._server.name, (current) => {
      const creds = this._usableEntry(current);
      return {
        ...bindingFieldsFor(creds, this._server.url, this._issuer),
        clientRegistration: clientInformation as Record<string, unknown>,
        // Preserve existing tokens; omit when none (tokens is optional).
        ...(creds?.tokens ? { tokens: creds.tokens } : {}),
        // Successful OAuth client registration proves the server supports
        // OAuth. Override any stale cached requirement.
        authRequirement: 'oauth',
        checkedAt: new Date().toISOString(),
      };
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const creds = await this._loadCredentials();
    if (!creds?.tokens?.access_token) {
      return undefined;
    }
    if (this._isAuthFailureBackoffActive()) {
      // The SDK's auth() refreshes unconditionally whenever the stored
      // tokens carry a refresh token. During the backoff, hand it the
      // access token without the refresh token so it skips its refresh
      // branch and terminates through redirectToAuthorization instead
      // of driving another doomed refresh.
      const { refresh_token: _refreshToken, ...rest } = creds.tokens;
      return rest;
    }
    return creds.tokens as OAuthTokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await mutateCredentials(this._configPath, this._server.name, (current) => {
      const creds = this._usableEntry(current);
      return {
        ...bindingFieldsFor(creds, this._server.url, this._issuer),
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
    });
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
    await mutateCredentials(this._configPath, this._server.name, (current) => {
      const creds = this._usableEntry(current);
      if (creds?.authRequirement) {
        return {
          authRequirement: creds.authRequirement,
          checkedAt: creds.checkedAt,
        };
      }
      return undefined;
    });
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
    await mutateCredentials(this._configPath, this._server.name, (current) => {
      const creds = this._usableEntry(current);
      if (!creds) {
        return current;
      }
      if (scope === 'tokens' && !tokensNeedInvalidation(creds.tokens)) {
        // The stored tokens are not the stale ones this invalidation
        // refers to: another process refreshed them while this one was
        // failing, and clearing them would discard valid credentials.
        return current;
      }
      const remaining: StoredCredentials = {
        ...bindingFieldsFor(creds, this._server.url, this._issuer),
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
        return undefined;
      }
      return remaining;
    });
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

  /**
   * Coordinates the reactive 401 path for an access token the server
   * just rejected: adopts a token another process stored while the
   * rejected request was in flight, or performs exactly one refresh
   * under the cross-process refresh lock. Concurrent 401s in this
   * process share a single attempt.
   *
   * Unlike {@link refreshIfNeeded}, a failure propagates to the caller
   * so the reactive path can report it — except when the failed
   * attempt finds that another process stored a different access token
   * while it was running: that winner is adopted and returned, so a
   * losing cross-process race does not surface as a failure.
   *
   * @param usedToken - The access token the rejected request carried.
   * @returns The adopted or refreshed tokens, or undefined when no
   *   adoption or refresh could be attempted (no stored tokens, no
   *   refresh token, or an active auth-failure backoff).
   * @throws When the token request or Protected Resource Metadata
   *   discovery fails and no concurrently stored token can be adopted.
   */
  async refreshAfterUnauthorized(usedToken: string): Promise<OAuthTokens | undefined> {
    if (this._authRefreshInFlight) {
      return this._authRefreshInFlight;
    }
    // Claim the slot synchronously so concurrent callers await the same
    // attempt rather than racing duplicate refreshes.
    this._authRefreshInFlight = this._runRefreshAfterUnauthorized(usedToken).finally(() => {
      this._authRefreshInFlight = undefined;
    });
    return this._authRefreshInFlight;
  }

  /**
   * Records that a 401 survived an adopted or freshly refreshed access
   * token and starts the auth-failure backoff. During the backoff
   * {@link tokens} hides the refresh token from the SDK's `auth()` flow
   * and {@link refreshIfNeeded} skips proactive refreshes, so a server
   * that keeps rejecting tokens cannot drive a refresh loop.
   */
  noteAuthFailure(): void {
    // Uniform jitter in [-1, 1) spreads the deadlines of concurrent
    // router instances so they do not retry a failing server in
    // lockstep.
    const jitter = Math.random() * 2 - 1;
    this._authFailureUntil =
      Date.now() + AUTH_FAILURE_COOLDOWN_MS * (1 + jitter * AUTH_FAILURE_COOLDOWN_JITTER);
  }

  /**
   * Clears the auth-failure backoff after a request with an adopted or
   * refreshed token succeeded, restoring normal refresh behavior.
   */
  noteAuthSuccess(): void {
    this._authFailureUntil = 0;
  }

  /**
   * Whether the auth-failure backoff is currently active.
   *
   * @returns True while refreshes are refused after a repeated 401.
   */
  private _isAuthFailureBackoffActive(): boolean {
    return Date.now() < this._authFailureUntil;
  }

  private async _runRefreshIfNeeded(logger?: Logger): Promise<void> {
    if (this._isAuthFailureBackoffActive()) {
      // A 401 just survived an adopted or freshly refreshed token;
      // another proactive refresh would only burn a token request.
      return;
    }
    // Cheap freshness check before taking the cross-process lock: the
    // common case (token still valid) must not touch the lock file.
    if (!dueRefreshToken((await this._loadCredentials())?.tokens)) {
      return;
    }
    try {
      await withRefreshLock(this._configPath, async () => {
        // Re-read under the lock: when another process refreshed while
        // this one waited, its fresh tokens are used as-is.
        const refreshToken = dueRefreshToken((await this._loadCredentials())?.tokens);
        if (!refreshToken) {
          return;
        }
        await this._refreshTokens(refreshToken);
      });
    } catch (err) {
      // Proactive refresh is best-effort; a lock failure must not break
      // the tool call. The SDK's reactive 401 path remains the fallback.
      if (logger) {
        logger.error('Proactive OAuth token refresh failed', {
          server: this._server.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * The coordinated attempt behind {@link refreshAfterUnauthorized}.
   *
   * Reads the usable stored entry first: a stored access token that
   * differs from `usedToken` is another process's fresh token and is
   * adopted without taking the refresh lock — even during the
   * auth-failure backoff. When the stored token is still the rejected
   * one and the backoff is active, no refresh is attempted. Otherwise
   * the cross-process refresh lock is taken and the entry re-read: a
   * changed token is adopted, a missing refresh token yields undefined,
   * and only a still-unchanged entry is refreshed once.
   *
   * When the coordinated attempt itself fails (refresh-lock timeout,
   * network error, transient Protected Resource Metadata discovery
   * failure, or a losing `invalid_grant` race), the entry is re-read
   * once more: a changed access token is adopted and returned, because
   * a peer has usually just stored a winner. Only when no adoptable
   * token exists does the original error propagate.
   *
   * @param usedToken - The access token the rejected request carried.
   * @returns The adopted or refreshed tokens, or undefined when no
   *   adoption or refresh could be attempted.
   * @throws When the token request or Protected Resource Metadata
   *   discovery fails and no concurrently stored token can be adopted.
   */
  private async _runRefreshAfterUnauthorized(usedToken: string): Promise<OAuthTokens | undefined> {
    const stored = await this._loadCredentials();
    const adopted = this._adoptStoredToken(usedToken, stored);
    if (adopted) {
      return adopted;
    }
    if (this._isAuthFailureBackoffActive()) {
      // A recent 401 survived an adopted or freshly refreshed token;
      // another refresh would only burn a token request.
      return undefined;
    }
    try {
      return await withRefreshLock(this._configPath, async () => {
        // Re-read under the lock: when another process refreshed while
        // this one waited, adopt its token instead of refreshing again.
        const current = await this._loadCredentials();
        const adoptedUnderLock = this._adoptStoredToken(usedToken, current);
        if (adoptedUnderLock) {
          return adoptedUnderLock;
        }
        const refreshToken = current?.tokens?.refresh_token;
        if (!refreshToken) {
          return undefined;
        }
        return this._refreshTokens(refreshToken);
      });
    } catch (err) {
      // The attempt failed. A peer may have stored a winner while it
      // was running (the losing `invalid_grant` race, or a refresh that
      // landed during a lock timeout or a transient failure): adopt it
      // instead of surfacing the failure.
      const storedAfterFailure = await this._loadCredentials();
      const winner = this._adoptStoredToken(usedToken, storedAfterFailure);
      if (winner) {
        return winner;
      }
      throw err;
    }
  }

  /**
   * Returns the tokens of a stored entry when its access token differs
   * from the one a rejected request carried — a token another process
   * stored while that request was in flight. Returns undefined when the
   * stored token is still the rejected one or no usable entry exists.
   *
   * @param usedToken - The access token the rejected request carried.
   * @param stored - The usable stored entry, if any.
   * @returns The adopted tokens, or undefined when there is nothing to
   *   adopt.
   */
  private _adoptStoredToken(
    usedToken: string,
    stored: StoredCredentials | undefined,
  ): OAuthTokens | undefined {
    if (stored?.tokens && stored.tokens.access_token !== usedToken) {
      return stored.tokens;
    }
    return undefined;
  }

  /**
   * Performs one token refresh through the shared refresh request:
   * discovers the authorization server metadata, calls the SDK's
   * `refreshAuthorization` with the RFC 8707 `resource` indicator
   * selected from the server's Protected Resource Metadata, and persists
   * the refreshed tokens via {@link saveTokens} (which recomputes
   * `expires_at`). Errors propagate to the caller so the coordinated
   * path can report the outcome; {@link refreshIfNeeded} keeps its
   * swallow-and-log behavior.
   *
   * @param refreshToken - The refresh token to present.
   * @returns The refreshed tokens, or undefined when no refresh could be
   *   attempted.
   * @throws When discovery or the token request fails, or when the
   *   Protected Resource Metadata probe failed transiently.
   */
  private async _refreshTokens(refreshToken: string): Promise<OAuthTokens | undefined> {
    return requestTokenRefresh(
      {
        serverUrl: this._server.url,
        provider: this,
        startupTimeoutMs: this._server.timeout.startup,
        setIssuer: (issuer) => this.setIssuer(issuer),
        saveTokens: (tokens) => this.saveTokens(tokens),
      },
      refreshToken,
    );
  }

  /**
   * Filters a raw stored entry down to the one this manager may use: an
   * entry bound to a different server URL or authorization server is
   * treated as absent so it is never sent anywhere.
   *
   * @param entry - The raw on-disk entry, if any.
   * @returns The usable entry, or undefined when it does not belong here.
   */
  private _usableEntry(entry: StoredCredentials | undefined): StoredCredentials | undefined {
    return credentialsUsableFor(entry, this._server.url, this._issuer) ? entry : undefined;
  }

  private async _loadCredentials(): Promise<StoredCredentials | undefined> {
    const all = await readCredentials(this._configPath);
    return this._usableEntry(all[this._server.name]);
  }
}
