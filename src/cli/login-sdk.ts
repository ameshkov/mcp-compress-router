// Cached lazy import for the SDK OAuth client module, so the heavy SDK
// auth module is loaded only when a login actually runs.
let _sdkAuth: typeof import('@modelcontextprotocol/sdk/client/auth.js') | undefined;

/**
 * Returns the SDK OAuth client module, loading it on first use.
 *
 * @returns The SDK `client/auth.js` module.
 */
export async function getSdkAuth(): Promise<
  typeof import('@modelcontextprotocol/sdk/client/auth.js')
> {
  if (!_sdkAuth) {
    _sdkAuth = await import('@modelcontextprotocol/sdk/client/auth.js');
  }
  return _sdkAuth;
}

/** SDK OAuth metadata type (non-null after discovery). */
export type OAuthMetadata = NonNullable<
  Awaited<
    ReturnType<
      (typeof import('@modelcontextprotocol/sdk/client/auth.js'))['discoverAuthorizationServerMetadata']
    >
  >
>;
