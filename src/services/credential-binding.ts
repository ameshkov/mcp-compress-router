import type { StoredCredentials } from '../utils/index.js';

/**
 * Normalizes a server URL for credential-binding comparison. The
 * canonical `URL.href` form lowercases the host, drops a default port,
 * and adds the trailing slash of an origin URL, so equivalent spellings
 * compare equal. A trailing slash on a non-origin path stays
 * significant: `https://example.com/mcp` and
 * `https://example.com/mcp/` are different endpoints.
 *
 * @param url - The server URL to normalize.
 * @returns The normalized URL, or undefined when the input is absent or
 *   not a valid absolute URL.
 */
function normalizeServerUrl(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url).href;
  } catch {
    return undefined;
  }
}

/**
 * Whether a credentials entry holds OAuth client registration or
 * tokens, as opposed to probe-only auth-requirement metadata.
 *
 * @param creds - The stored credentials entry, if any.
 * @returns True when the entry carries credential material.
 */
function hasCredentialMaterial(creds: StoredCredentials | undefined): creds is StoredCredentials {
  return (
    creds !== undefined && (creds.clientRegistration !== undefined || creds.tokens !== undefined)
  );
}

/**
 * Whether stored credentials may be used for a downstream server.
 *
 * An entry is bound to the server it was created for: credentials are
 * only usable while the configured URL matches the recorded
 * `serverUrl`, and, when both the entry and the caller know the
 * authorization server issuer, only while the issuers match. This
 * keeps a leftover entry from a removed or renamed server from being
 * presented to a different domain.
 *
 * Entries without a recorded `serverUrl` (written before the binding
 * existed) are adopted: they stay usable and are bound on the next
 * write. Probe-only entries (no client registration, no tokens) carry
 * no credential material and are always usable.
 *
 * @param creds - The stored credentials entry, if any.
 * @param serverUrl - The configured URL of the downstream server.
 * @param issuer - The discovered authorization server issuer, when
 *   known. Omitted when the caller has not discovered metadata.
 * @returns True when the credentials may be used for this server.
 */
export function credentialsUsableFor(
  creds: StoredCredentials | undefined,
  serverUrl: string | undefined,
  issuer?: string,
): boolean {
  if (!hasCredentialMaterial(creds)) {
    return true;
  }
  const currentUrl = normalizeServerUrl(serverUrl);
  if (currentUrl === undefined) {
    return false;
  }
  if (creds.serverUrl !== undefined) {
    const storedUrl = normalizeServerUrl(creds.serverUrl);
    if (storedUrl === undefined || storedUrl !== currentUrl) {
      return false;
    }
  }
  if (issuer !== undefined && creds.issuer !== undefined && creds.issuer !== issuer) {
    return false;
  }
  return true;
}

/**
 * Resolves the `serverUrl` to record on a credentials write. An
 * existing binding on an entry with credential material wins — a URL
 * change must not re-bind credentials to the new server. A probe-only
 * entry keeps no binding: its URL describes where a probe ran, and
 * inheriting it would stamp fresh credentials with a stale server URL.
 * Either way an unbound entry is bound to the current server URL.
 *
 * @param existing - The entry being replaced, if any.
 * @param serverUrl - The configured URL of the downstream server.
 * @returns The URL to record, or undefined when neither source yields a
 *   valid URL.
 */
export function resolveBindingUrl(
  existing: StoredCredentials | undefined,
  serverUrl: string | undefined,
): string | undefined {
  const boundUrl = hasCredentialMaterial(existing) ? existing.serverUrl : undefined;
  return boundUrl ?? normalizeServerUrl(serverUrl);
}

/**
 * Resolves the binding fields (`serverUrl`, `issuer`) recorded on
 * every credentials write: the URL of the server the entry belongs to,
 * and the authorization server issuer when it is known. A probe-only
 * entry carries no credential material, so its binding is not
 * inherited; otherwise existing values are preserved when the caller
 * cannot determine them, so a write never strips a binding.
 *
 * @param existing - The entry being replaced, if any.
 * @param serverUrl - The configured URL of the downstream server.
 * @param issuer - The authorization server issuer for the current
 *   flow, when discovered.
 * @returns The binding fields to spread into the written entry.
 */
export function bindingFieldsFor(
  existing: StoredCredentials | undefined,
  serverUrl: string | undefined,
  issuer: string | undefined,
): Pick<StoredCredentials, 'serverUrl' | 'issuer'> {
  const boundUrl = resolveBindingUrl(existing, serverUrl);
  const resolvedIssuer = issuer ?? (hasCredentialMaterial(existing) ? existing.issuer : undefined);
  return {
    ...(boundUrl !== undefined ? { serverUrl: boundUrl } : {}),
    ...(resolvedIssuer !== undefined ? { issuer: resolvedIssuer } : {}),
  };
}
