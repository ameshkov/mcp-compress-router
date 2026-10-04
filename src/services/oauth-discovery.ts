import type {
  AuthorizationServerMetadata,
  OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { createTimeoutFetch, getAuthDiscoveryTimeoutMs } from '../utils/index.js';

// Cached lazy import for the SDK OAuth discovery helpers, so the heavy
// SDK auth module is only loaded when discovery actually runs.
let _sdkAuth: typeof import('@modelcontextprotocol/sdk/client/auth.js') | undefined;

/**
 * Returns the SDK auth module, loading it on first use.
 *
 * @returns The SDK `client/auth.js` module.
 */
async function _getSdkAuth(): Promise<typeof import('@modelcontextprotocol/sdk/client/auth.js')> {
  if (!_sdkAuth) {
    _sdkAuth = await import('@modelcontextprotocol/sdk/client/auth.js');
  }
  return _sdkAuth;
}

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
  /**
   * Whether the authorization server advertised RFC 9207
   * `authorization_response_iss_parameter_supported: true`. Read from the
   * raw metadata document because the SDK parses OpenID Connect discovery
   * metadata with a schema that strips fields it does not declare. Always
   * `false` when no metadata was discovered.
   */
  authorizationResponseIssParameterSupported: boolean;
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
 * Captured raw JSON of a successful metadata response, filled in by
 * {@link createRawMetadataFetch}.
 */
interface RawMetadataCapture {
  /** Raw JSON body of the last successful response, when it parsed. */
  raw?: Record<string, unknown>;
}

/**
 * Wraps a fetch function so the raw JSON body of every successful
 * response is captured. The SDK parses OpenID Connect discovery metadata
 * with a schema that strips undeclared fields (such as the RFC 9207
 * `authorization_response_iss_parameter_supported` flag), so the raw
 * document is the only place those fields remain observable.
 *
 * The SDK's discovery helper returns as soon as one discovery URL yields
 * metadata, so the last captured body belongs to the response the
 * returned metadata was parsed from.
 *
 * @param base - The fetch function to wrap.
 * @param capture - Sink for the raw JSON body.
 * @returns A fetch function that captures successful JSON responses.
 */
function createRawMetadataFetch(base: typeof fetch, capture: RawMetadataCapture): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (response.ok) {
      try {
        const raw: unknown = await response.clone().json();
        if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
          capture.raw = raw as Record<string, unknown>;
        }
      } catch {
        // A non-JSON body is a clean discovery miss, not metadata; the
        // SDK reports it to the caller.
      }
    }
    return response;
  };
}

/**
 * Reads the RFC 9207 `authorization_response_iss_parameter_supported`
 * flag from the captured raw metadata document.
 *
 * @param capture - The captured raw metadata, when one was parsed.
 * @returns True when the document declares the flag as `true`.
 */
function readIssParameterSupported(capture: RawMetadataCapture): boolean {
  return capture.raw?.authorization_response_iss_parameter_supported === true;
}

/**
 * Result of probing a single authorization-server candidate.
 */
interface CandidateResult {
  /** The candidate URL that was probed. */
  url: URL;
  /** The metadata found at the candidate. */
  metadata: AuthorizationServerMetadata;
  /** RFC 9207 `iss` support read from the raw metadata document. */
  authorizationResponseIssParameterSupported: boolean;
}

/**
 * Races every candidate probe in parallel and resolves with the first
 * candidate that finds metadata. Candidates that miss (or error) are
 * treated as rejections, so a hung endpoint on one candidate can never
 * delay a hit found by another candidate.
 *
 * @param urls - The candidate URLs to probe.
 * @param probe - The per-candidate probe callback (never throws; returns
 *   `undefined` on a miss).
 * @returns The first hit, or `undefined` when every candidate missed.
 */
async function raceCandidates(
  urls: URL[],
  probe: (url: URL) => Promise<CandidateResult | undefined>,
): Promise<CandidateResult | undefined> {
  if (urls.length === 0) {
    return undefined;
  }
  return Promise.any(
    urls.map(async (url) => {
      const result = await probe(url);
      if (!result) {
        throw new Error(`No OAuth metadata at ${url.href}`);
      }
      return result;
    }),
  ).catch(() => undefined);
}

/**
 * Builds the authorization-server candidate URL groups for discovery.
 * Advertised AS URLs (from RFC 9728 Protected Resource Metadata) take
 * precedence; the legacy fallback group — the server URL itself and, for
 * subpath URLs, its origin root — is only probed when no advertised AS
 * yields metadata.
 *
 * @param serverUrl - The downstream MCP server URL.
 * @param resourceMetadata - Discovered Protected Resource Metadata, if any.
 * @returns The advertised and fallback candidate URL lists.
 */
function buildCandidateUrls(
  serverUrl: URL,
  resourceMetadata: OAuthProtectedResourceMetadata | undefined,
): { advertised: URL[]; fallback: URL[] } {
  const advertised = (resourceMetadata?.authorization_servers ?? [])
    .map((value) => toUrl(value))
    .filter((url): url is URL => url !== undefined);
  const fallback: URL[] = [serverUrl];
  if (serverUrl.pathname !== '/') {
    fallback.push(new URL(serverUrl.origin));
  }
  return { advertised, fallback };
}

/**
 * Builds the discovery result from an optional candidate hit.
 *
 * @param resourceMetadata - Discovered Protected Resource Metadata, if any.
 * @param hit - The winning AS candidate, or `undefined` on a full miss.
 * @param serverUrl - The downstream MCP server URL (fallback AS URL).
 * @returns The discovery result.
 */
function toDiscoveredAuth(
  resourceMetadata: OAuthProtectedResourceMetadata | undefined,
  hit: CandidateResult | undefined,
  serverUrl: URL,
): DiscoveredAuth {
  if (!hit) {
    return {
      resourceMetadata,
      serverMetadata: undefined,
      authorizationServerUrl: serverUrl,
      authorizationResponseIssParameterSupported: false,
    };
  }
  return {
    resourceMetadata,
    serverMetadata: hit.metadata,
    authorizationServerUrl: hit.url,
    authorizationResponseIssParameterSupported: hit.authorizationResponseIssParameterSupported,
  };
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
    await _getSdkAuth();

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
  // The raw metadata document is captured alongside the SDK's parsed
  // result so RFC 9207 fields stripped by the OIDC schema stay visible.
  const safeDiscoverAs = async (url: URL): Promise<CandidateResult | undefined> => {
    const capture: RawMetadataCapture = {};
    try {
      const metadata = await discoverAuthorizationServerMetadata(url, {
        fetchFn: createRawMetadataFetch(fetchFn, capture),
      });
      if (!metadata) {
        return undefined;
      }
      return {
        url,
        metadata,
        authorizationResponseIssParameterSupported: readIssParameterSupported(capture),
      };
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

  // Step 2: probe the candidates in parallel, first hit wins.
  const { advertised, fallback } = buildCandidateUrls(serverUrl, resourceMetadata);

  const advertisedHit = await raceCandidates(advertised, safeDiscoverAs);
  if (advertisedHit) {
    return toDiscoveredAuth(resourceMetadata, advertisedHit, serverUrl);
  }

  const fallbackHit = await raceCandidates(fallback, safeDiscoverAs);
  if (fallbackHit) {
    return toDiscoveredAuth(resourceMetadata, fallbackHit, serverUrl);
  }

  // No metadata found anywhere. If any candidate actually errored (vs. a
  // clean 404 or a non-JSON response), surface that so callers can report
  // a probe failure rather than a misleading "no OAuth supported".
  if (lastError !== undefined) {
    throw lastError;
  }

  return toDiscoveredAuth(resourceMetadata, undefined, serverUrl);
}
