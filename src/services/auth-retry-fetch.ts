import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Logger } from '../utils/index.js';
import type { OAuthCredentialManager } from './oauth.js';

/**
 * Extracts the access token a request carries in its `Authorization`
 * header. A missing header, a non-Bearer scheme, or an empty token all
 * yield `undefined`, so the caller leaves the response untouched.
 *
 * @param headers - The request's headers, if any.
 * @returns The bearer token, or undefined when the request carries none.
 */
function bearerToken(headers: HeadersInit | undefined): string | undefined {
  const authorization = new Headers(headers).get('authorization');
  if (authorization === null) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1];
}

/**
 * Returns a copy of the request init whose `Authorization` header
 * carries the given access token. Every other header and the body are
 * preserved as-is, so a JSON-RPC body can be replayed verbatim.
 *
 * @param init - The original request init.
 * @param accessToken - The replacement access token.
 * @returns The request init for the retried request.
 */
function withBearerToken(init: RequestInit | undefined, accessToken: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${accessToken}`);
  return { ...init, headers };
}

/**
 * Wraps a fetch implementation so a 401 that carried a bearer token is
 * retried once through the credential manager's coordinated
 * adopt-or-refresh path.
 *
 * The wrapper sees the outgoing `Authorization: Bearer <T>` header, so
 * it knows exactly which token the rejected request carried. On a 401
 * it asks the manager for a replacement: another process's freshly
 * stored token is adopted without a refresh, and only a still-current
 * token drives one coordinated refresh under the cross-process lock.
 * When the manager yields a token, the 401 body is cancelled and the
 * request is replayed once with the replacement token — the same init,
 * including the same body (JSON-RPC bodies are strings, so reuse is
 * safe). A retried non-401 response clears the auth-failure backoff; a
 * retried 401 records the failure and is returned, so the SDK's
 * `auth()` flow terminates instead of looping.
 *
 * Only 401 responses are handled: non-401 responses, requests without a
 * bearer token, and a rejecting `baseFetch` pass through or propagate
 * untouched. When the manager cannot attempt an adoption or refresh,
 * the original 401 is returned with its body intact. A thrown
 * coordinated attempt — after the manager's own failure-path re-read
 * found no concurrently stored winner — also records the auth failure
 * before the original 401 is returned, so `tokens()` omits
 * `refresh_token` and the SDK's `auth()` terminates instead of
 * refreshing outside the cross-process lock.
 *
 * @param baseFetch - The underlying fetch to wrap.
 * @param manager - The credential manager for the downstream server, or
 *   undefined when the server has no OAuth credentials (the base fetch
 *   is returned unchanged).
 * @param logger - Optional structured logger for adopt/refresh/backoff
 *   diagnostics. Token values are never logged.
 * @returns A fetch-compatible function with the auth retry applied.
 */
export function createAuthRetryFetch(
  baseFetch: FetchLike,
  manager: OAuthCredentialManager | undefined,
  logger?: Logger,
): FetchLike {
  if (!manager) {
    return baseFetch;
  }
  return async (url, init) => {
    const response = await baseFetch(url, init);
    if (response.status !== 401) {
      return response;
    }
    const usedToken = bearerToken(init?.headers);
    if (usedToken === undefined) {
      return response;
    }

    let tokens: OAuthTokens | undefined;
    try {
      tokens = await manager.refreshAfterUnauthorized(usedToken);
    } catch (err) {
      logger?.warn('Coordinated OAuth token refresh failed', {
        server: manager.serverName,
        error: err instanceof Error ? err.message : String(err),
      });
      // The manager throws only when the failed attempt found no
      // concurrently stored token to adopt. Record the auth failure so
      // tokens() hides refresh_token and the SDK's auth() flow
      // terminates instead of refreshing uncoordinated.
      manager.noteAuthFailure();
      return response;
    }
    if (tokens === undefined) {
      // No adoption or refresh could be attempted; the SDK's own
      // auth() flow handles the 401 with the body left intact.
      return response;
    }

    logger?.debug('Adopted or refreshed OAuth token; retrying request', {
      server: manager.serverName,
    });
    await response.body?.cancel();
    const retried = await baseFetch(url, withBearerToken(init, tokens.access_token));
    if (retried.status !== 401) {
      manager.noteAuthSuccess();
      return retried;
    }
    await retried.body?.cancel();
    manager.noteAuthFailure();
    logger?.warn('OAuth token still rejected; entering auth-failure backoff', {
      server: manager.serverName,
    });
    return retried;
  };
}
