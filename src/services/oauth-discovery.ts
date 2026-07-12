import type {
  AuthorizationServerMetadata,
  OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * Result of OAuth discovery for a downstream MCP server.
 */
interface DiscoveredAuth {
  /** RFC 9728 Protected Resource Metadata, when published by the server. */
  resourceMetadata?: OAuthProtectedResourceMetadata;
  /**
   * RFC 8414 / OIDC Authorization Server Metadata, when discoverable.
   * Absent when no OAuth endpoints could be found.
   */
  serverMetadata?: AuthorizationServerMetadata;
  /**
   * The URL Authorization Server Metadata was discovered at: an
   * `authorization_servers` entry, the origin root (legacy fallback), or the
   * server URL itself.
   */
  authorizationServerUrl: URL;
}

/**
 * Discovers OAuth metadata for a downstream MCP server following the
 * MCP 2025-06-18 authorization spec two-step flow:
 *
 * 1. RFC 9728 Protected Resource Metadata (PRM) at the server URL. When
 *    present, its `authorization_servers` array lists the AS URLs to query.
 * 2. RFC 8414 / OIDC Authorization Server Metadata at each advertised AS URL.
 *
 * Legacy servers that publish AS metadata directly at their host root without
 * PRM are still supported: when no PRM is found (or it advertises no usable
 * AS), discovery falls back to the server URL and, if that URL has a path,
 * its origin root.
 *
 * All per-candidate discovery errors are swallowed and treated as "not
 * found" so a single flaky endpoint never aborts the whole flow — discovery
 * falls through to the next candidate. When no metadata is found anywhere
 * AND at least one candidate threw, the last error is re-thrown so callers
 * can distinguish a clean "no OAuth published" (all 404s) from an actual
 * server/network failure (e.g. the auth probe reports `'unknown'`, the
 * login command throws a guided error).
 *
 * @param serverUrl - The downstream MCP server URL to discover auth for.
 * @returns The discovered resource and/or server metadata plus the AS URL
 *   that yielded the metadata. `serverMetadata` is `undefined` when no OAuth
 *   endpoints could be discovered.
 * @throws The last discovery error when no metadata was found and at least
 *   one candidate endpoint errored. Clean "not found" (all 404s) does not
 *   throw.
 */
export async function discoverAuth(serverUrl: URL): Promise<DiscoveredAuth> {
  const { discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata } =
    await import('@modelcontextprotocol/sdk/client/auth.js');

  // Tracks the last error seen across all candidates so the caller can be
  // notified when discovery failed entirely (vs. cleanly finding nothing).
  let lastError: unknown;

  // Tolerant AS discovery: any error (404-as-throw, 5xx, network) is
  // recorded and treated as "not found" so the next candidate is tried.
  const safeDiscoverAs = async (url: URL): Promise<AuthorizationServerMetadata | undefined> => {
    try {
      return await discoverAuthorizationServerMetadata(url);
    } catch (err) {
      lastError = err;
      return undefined;
    }
  };

  // Step 1: RFC 9728 Protected Resource Metadata. This SDK function throws
  // when no PRM is published (treated as "no PRM, fall through"), so its
  // error is intentionally NOT recorded — absence of PRM is the normal
  // legacy-server path, not a probe failure.
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl);
  } catch {
    // No PRM published; fall through to direct AS discovery below.
  }

  // Step 2: AS metadata at each advertised authorization server.
  if (resourceMetadata?.authorization_servers?.length) {
    for (const asUrlString of resourceMetadata.authorization_servers) {
      const asUrl = new URL(asUrlString);
      const metadata = await safeDiscoverAs(asUrl);
      if (metadata) {
        return { resourceMetadata, serverMetadata: metadata, authorizationServerUrl: asUrl };
      }
    }
  }

  // Legacy fallback: direct AS discovery at the server URL, then its origin
  // root (for servers that host AS metadata at the root with the MCP endpoint
  // on a subpath and no PRM).
  const candidates: URL[] = [serverUrl];
  if (serverUrl.pathname !== '/') {
    candidates.push(new URL(serverUrl.origin));
  }
  for (const candidate of candidates) {
    const metadata = await safeDiscoverAs(candidate);
    if (metadata) {
      return { resourceMetadata, serverMetadata: metadata, authorizationServerUrl: candidate };
    }
  }

  // No metadata found anywhere. If any candidate actually errored (vs. a
  // clean 404), surface that so callers can report a probe failure rather
  // than a misleading "no OAuth supported".
  if (lastError !== undefined) {
    throw lastError;
  }

  return { resourceMetadata, serverMetadata: undefined, authorizationServerUrl: serverUrl };
}
