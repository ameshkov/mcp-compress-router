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
