/**
 * Tagged error thrown when a downstream server requires OAuth
 * authentication that cannot be completed from the running router
 * process.
 *
 * The MCP SDK calls `OAuthClientProvider.redirectToAuthorization()` on
 * a 401 response. This error is thrown from that method so callers
 * can discriminate auth failures from other errors (network, config,
 * transport) without relying on substring matching of error messages.
 */
export class GuidedAuthError extends Error {
  /** The downstream server name that requires authentication. */
  readonly serverName: string;

  /**
   * @param serverName - The name of the server requiring authentication.
   */
  constructor(serverName: string) {
    super(`Authentication required for server "${serverName}".`);
    this.name = 'GuidedAuthError';
    this.serverName = serverName;
  }
}

/**
 * HTTP status codes that indicate an authentication or authorization
 * failure at the transport layer. The MCP SDK's streamable HTTP
 * transport surfaces the upstream response status as a numeric `code`
 * property on the thrown error — e.g. 401 when the server rejects a
 * request without driving the SDK's `redirectToAuthorization` flow.
 */
const AUTH_ERROR_STATUSES = new Set([401, 403]);

/**
 * Error message substrings that indicate a downstream OAuth /
 * access-token failure rather than a network, transport, or tool-level
 * error. These surface when a server rejects a request in the response
 * body (e.g. with an OAuth error code) instead of returning a clean 401
 * that would drive the SDK's `redirectToAuthorization` flow (which
 * throws {@link GuidedAuthError} directly).
 *
 * Matching is case-insensitive to tolerate casing differences across
 * SDK versions and server implementations.
 */
const AUTH_ERROR_PATTERNS = [
  'invalid_token',
  'invalid_grant',
  'invalid_client',
  'missing or invalid access token',
];

/**
 * Reads the HTTP status code attached to an error, if any.
 *
 * The MCP SDK's `StreamableHTTPError` exposes the upstream HTTP status
 * as a numeric `code` property. JSON-RPC error codes (e.g. `-32601`
 * Method not found) are negative and never collide with HTTP status
 * codes, so a positive value here is unambiguously an HTTP status.
 * Duck-typed to avoid importing the SDK error class (mirrors the
 * `isMethodNotFound` approach in `discovery.ts`).
 *
 * @param err - The thrown value from connect, reconnect, or invoke.
 * @returns The HTTP status code, or `undefined` when none is present.
 */
function getHttpStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}

/**
 * Determines whether an error represents an authentication failure
 * (missing, invalid, or expired OAuth credentials) rather than a
 * network, transport, or tool-level error.
 *
 * Returns true for {@link GuidedAuthError} instances, for raw
 * transport errors carrying an HTTP 401/403 status (read from the
 * `code` property), and for errors whose message carries an OAuth
 * error code such as `invalid_token` or `invalid_grant`. Without
 * this, a server that rejects a request is misclassified as a generic
 * connection failure, and the guided error tells the user to check
 * their network instead of running `login`.
 *
 * @param err - The error thrown during connect, reconnect, or invoke.
 * @returns True when the error indicates authentication is required.
 */
export function isAuthError(err: unknown): boolean {
  if (err instanceof GuidedAuthError) {
    return true;
  }
  const status = getHttpStatus(err);
  if (status !== undefined && AUTH_ERROR_STATUSES.has(status)) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}
