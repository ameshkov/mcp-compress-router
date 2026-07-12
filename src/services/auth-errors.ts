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
