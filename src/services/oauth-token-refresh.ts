import {
  refreshAuthorization,
  selectResourceURL,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { StoredCredentials } from '../utils/index.js';
import { createTimeoutFetch, getDownstreamTimeoutMs } from '../utils/index.js';
import { discoverAuth } from './oauth-discovery.js';

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
export function computeExpiresAt(expiresIn: number | undefined): string | undefined {
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
 * Returns the refresh token when the stored tokens are due for a
 * proactive refresh (expired or within the refresh buffer), or undefined
 * when no refresh is needed or none can be attempted.
 *
 * @param tokens - The stored tokens, if any.
 * @returns The refresh token to present, or undefined.
 */
export function dueRefreshToken(tokens: StoredCredentials['tokens']): string | undefined {
  if (!tokens?.refresh_token || !tokens.expires_at) {
    return undefined;
  }
  return needsRefresh(tokens.expires_at) ? tokens.refresh_token : undefined;
}

/**
 * Whether stored tokens should be cleared after a token request failed
 * with a recoverable OAuth error. Tokens that are no longer due for a
 * refresh were replaced by another process in the meantime — clearing
 * them would discard that process's fresh credentials — so only stale
 * (or legacy, expiry-less) tokens are invalidated.
 *
 * @param tokens - The tokens currently stored for the server.
 * @returns True when the invalidation request should clear them.
 */
export function tokensNeedInvalidation(tokens: StoredCredentials['tokens']): boolean {
  if (!tokens) {
    return false;
  }
  if (tokens.expires_at === undefined) {
    // No expiry information: cannot prove the tokens are fresh, so honor
    // the invalidation request.
    return true;
  }
  return needsRefresh(tokens.expires_at);
}

/**
 * The inputs one refresh request needs, supplied by the credential
 * manager. `setIssuer` and `saveTokens` must be closures bound to the
 * manager — never bare method references — so `this` survives the call.
 */
interface TokenRefreshContext {
  /** The configured URL of the downstream server. */
  serverUrl: string | undefined;
  /** The provider used to read the client registration and select the resource. */
  provider: OAuthClientProvider;
  /** Records the discovered authorization server issuer for the flow. */
  setIssuer(issuer: string): void;
  /** Persists the refreshed tokens (recomputing `expires_at`). */
  saveTokens(tokens: OAuthTokens): Promise<void>;
}

/**
 * Performs one token refresh: discovers the authorization server
 * metadata, calls the SDK's `refreshAuthorization`, and persists the
 * refreshed tokens via `context.saveTokens` (which recomputes
 * `expires_at`). The request carries the RFC 8707 `resource` indicator
 * selected from the server's Protected Resource Metadata — the same
 * indicator `login` sent — so a provider that binds tokens to a
 * specific resource accepts the refresh.
 *
 * A transient Protected Resource Metadata discovery failure fails the
 * refresh instead of issuing an unbound token: the server may bind
 * tokens to a resource, and an unbound token is rejected as "not bound
 * to this server". Errors propagate; nothing is swallowed, so callers
 * can report the outcome.
 *
 * @param context - The manager-supplied inputs for the request.
 * @param refreshToken - The refresh token to present.
 * @returns The refreshed tokens, or undefined when no refresh could be
 *   attempted (no server URL, no server metadata, or no client
 *   registration).
 * @throws When Protected Resource Metadata discovery failed
 *   transiently, or when the token request itself fails.
 */
export async function requestTokenRefresh(
  context: TokenRefreshContext,
  refreshToken: string,
): Promise<OAuthTokens | undefined> {
  if (!context.serverUrl) {
    return undefined;
  }
  const serverUrl = new URL(context.serverUrl);
  const discovered = await discoverAuth(serverUrl);
  if (discovered.resourceMetadataDiscoveryFailed) {
    throw new Error(
      'OAuth token refresh aborted: Protected Resource Metadata discovery failed transiently.',
    );
  }
  if (!discovered.serverMetadata) {
    return undefined;
  }
  // Record the issuer before reading the client registration: an
  // entry obtained from a different authorization server must not
  // be used for the refresh.
  context.setIssuer(discovered.serverMetadata.issuer);
  const clientInformation = await context.provider.clientInformation();
  if (!clientInformation) {
    return undefined;
  }
  const resource = await selectResourceURL(
    serverUrl,
    context.provider,
    discovered.resourceMetadata,
  );
  const newTokens = await refreshAuthorization(discovered.authorizationServerUrl, {
    metadata: discovered.serverMetadata,
    clientInformation,
    refreshToken,
    resource,
    // Bound the token request like the connect-time token exchange:
    // a hung token endpoint must not hold the cross-process refresh
    // lock (or the invoking tool call) indefinitely.
    fetchFn: createTimeoutFetch(getDownstreamTimeoutMs()),
  });
  await context.saveTokens(newTokens);
  return newTokens;
}
