import type { OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * Whether a stored dynamic client registration is unusable because its
 * client secret has expired.
 *
 * RFC 7591 §3.2.1 defines `client_secret_expires_at` as the number of
 * seconds since the Unix epoch and requires clients to ignore a zero
 * value; an absent field means the secret does not expire. An expired
 * registration cannot authenticate a token request — the authorization
 * server rejects it with `invalid_client` (for example, "Client secret
 * has expired") — so callers treat it as if no registration were stored.
 *
 * @param client - The stored client registration, if any.
 * @returns True when the registration carries a secret expiry in the
 *   past.
 */
export function clientSecretExpired(client: OAuthClientInformationMixed | undefined): boolean {
  if (!client) {
    return false;
  }
  const expiresAt = client.client_secret_expires_at;
  return typeof expiresAt === 'number' && expiresAt !== 0 && expiresAt * 1000 <= Date.now();
}

/**
 * Whether an error is the authorization server's `invalid_client`
 * rejection of the client registration a request carried.
 *
 * Local checks cannot prove that the provider still knows a registration:
 * a provider can forget or revoke a client without giving it an expiry.
 * The provider's own `invalid_client` response is the only authoritative
 * signal, so callers discard the rejected registration; a new client
 * registration replaces it (the runtime flow may register it during the
 * same call through the SDK's `auth()` retry, while the login flow
 * leaves it to the next login). The SDK's `OAuthError` subclasses expose
 * the OAuth error code as an `errorCode` property; it is read duck-typed
 * here, mirroring the `isAuthError` approach, so this module does not
 * import the SDK's server-side error classes.
 *
 * @param err - The thrown value from a token request.
 * @returns True when the error reports `invalid_client`.
 */
export function isInvalidClientError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return (err as { errorCode?: unknown }).errorCode === 'invalid_client';
}
