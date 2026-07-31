import type {
  AuthorizationServerMetadata,
  OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { createTimeoutFetch, getAuthDiscoveryTimeoutMs } from '../utils/index.js';

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
 * Returns true when the thrown error means an endpoint responded with a
 * body that is not JSON (e.g. an HTML page, an SPA catch-all route, or a
 * proxy error page). The SDK parses well-known metadata with
 * `response.json()`, which throws `SyntaxError` on invalid JSON.
 *
 * Such a response is a server's way of saying "no OAuth metadata here",
 * not a probe failure: the endpoint answered, it just is not an OAuth
 * metadata endpoint. These misses must not surface as errors — a plain
 * web page at the well-known path means the server publishes no OAuth
 * metadata (auth requirement `'none'`), not that probing is broken.
 *
 * @param err - The thrown value from an SDK discovery helper.
 * @returns True when the error is a JSON parse failure.
 */
function isNonJsonResponse(err: unknown): boolean {
  return err instanceof SyntaxError;
}

/**
 * Converts a raw `authorization_servers` string into a URL. Returns
 * `undefined` for malformed entries so a broken PRM advertisement is
 * skipped like any other failed candidate instead of aborting discovery.
 *
 * @param value - The advertised authorization server URL string.
 * @returns The parsed URL, or `undefined` when malformed.
 */
function toUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Result of probing a single authorization-server candidate.
 */
interface CandidateResult {
  /** The candidate URL that was probed. */
  url: URL;
  /** The metadata found at the candidate, or `undefined` on a miss. */
  metadata: AuthorizationServerMetadata | undefined;
}

/**
 * Races every candidate probe in parallel and resolves with the first
 * candidate that finds metadata. Candidates that miss (or error) are
 * treated as rejections, so a hung endpoint on one candidate can never
 * delay a hit found by another candidate.
 *
 * @param urls - The candidate URLs to probe.
 * @param probe - The per-candidate probe callback (never throws).
 * @returns The first hit, or `undefined` when every candidate missed.
 */
async function raceCandidates(
  urls: URL[],
  probe: (url: URL) => Promise<AuthorizationServerMetadata | undefined>,
): Promise<CandidateResult | undefined> {
  if (urls.length === 0) {
    return undefined;
  }
  return Promise.any(
    urls.map(async (url) => {
      const metadata = await probe(url);
      if (!metadata) {
        throw new Error(`No OAuth metadata at ${url.href}`);
      }
      return { url, metadata } satisfies CandidateResult;
    }),
  ).catch(() => undefined);
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
 * The candidates of each group are probed **in parallel** and the first
 * hit wins, so a hung well-known endpoint on one candidate never delays
 * discovery of another. PRM-advertised AS URLs are preferred over the
 * legacy fallback candidates (the fallback group is only probed when no
 * advertised AS yields metadata).
 *
 * A candidate that responds with a non-JSON body (e.g. HTML) is treated as
 * "not an OAuth endpoint" — a clean miss, not a probe failure. All other
 * per-candidate errors (5xx, network, timeout) are swallowed and treated as
 * "not found" so a single flaky endpoint never aborts the whole flow.
 * When no metadata is found anywhere AND at least one candidate threw a
 * genuine error, the last such error is re-thrown so callers can
 * distinguish a clean "no OAuth published" (all 404s / non-JSON) from an
 * actual server/network failure (e.g. the auth probe reports `'unknown'`,
 * the login command throws a guided error).
 *
 * @param serverUrl - The downstream MCP server URL to discover auth for.
 * @returns The discovered resource and/or server metadata plus the AS URL
 *   that yielded the metadata. `serverMetadata` is `undefined` when no OAuth
 *   endpoints could be discovered.
 * @throws The last discovery error when no metadata was found and at least
 *   one candidate endpoint errored. Clean "not found" (all 404s or
 *   non-JSON responses) does not throw.
 */
export async function discoverAuth(serverUrl: URL): Promise<DiscoveredAuth> {
  const { discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata } =
    await import('@modelcontextprotocol/sdk/client/auth.js');

  // The SDK discovery helpers use a raw fetch with no timeout; a server
  // that hangs its well-known endpoint would trap discovery forever. Pass
  // a fetch that aborts after a short, configurable budget.
  const fetchFn = createTimeoutFetch(getAuthDiscoveryTimeoutMs());

  // Tracks the last genuine error seen across all candidates so the caller
  // can be notified when discovery failed entirely (vs. cleanly finding
  // nothing). Non-JSON responses are excluded — they are clean misses.
  let lastError: unknown;

  // Tolerant AS discovery: any error (404-as-throw, 5xx, network) is
  // recorded and treated as "not found" so the other candidates are tried.
  const safeDiscoverAs = async (url: URL): Promise<AuthorizationServerMetadata | undefined> => {
    try {
      return await discoverAuthorizationServerMetadata(url, { fetchFn });
    } catch (err) {
      if (!isNonJsonResponse(err)) {
        lastError = err;
      }
      return undefined;
    }
  };

  // Step 1: RFC 9728 Protected Resource Metadata. This SDK function throws
  // when no PRM is published (treated as "no PRM, fall through"), so its
  // error is intentionally NOT recorded — absence of PRM is the normal
  // legacy-server path, not a probe failure.
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl, {}, fetchFn);
  } catch {
    // No PRM published; fall through to direct AS discovery below.
  }

  // Step 2: probe the candidates in parallel, first hit wins. Advertised
  // AS URLs take precedence; the legacy fallback group (the server URL
  // and, for subpath URLs, its origin root) is only probed when no
  // advertised AS yields metadata.
  const advertisedUrls = (resourceMetadata?.authorization_servers ?? [])
    .map((value) => toUrl(value))
    .filter((url): url is URL => url !== undefined);
  const fallbackUrls: URL[] = [serverUrl];
  if (serverUrl.pathname !== '/') {
    fallbackUrls.push(new URL(serverUrl.origin));
  }

  const advertisedHit = await raceCandidates(advertisedUrls, safeDiscoverAs);
  if (advertisedHit) {
    return {
      resourceMetadata,
      serverMetadata: advertisedHit.metadata,
      authorizationServerUrl: advertisedHit.url,
    };
  }

  const fallbackHit = await raceCandidates(fallbackUrls, safeDiscoverAs);
  if (fallbackHit) {
    return {
      resourceMetadata,
      serverMetadata: fallbackHit.metadata,
      authorizationServerUrl: fallbackHit.url,
    };
  }

  // No metadata found anywhere. If any candidate actually errored (vs. a
  // clean 404 or a non-JSON response), surface that so callers can report
  // a probe failure rather than a misleading "no OAuth supported".
  if (lastError !== undefined) {
    throw lastError;
  }

  return { resourceMetadata, serverMetadata: undefined, authorizationServerUrl: serverUrl };
}
