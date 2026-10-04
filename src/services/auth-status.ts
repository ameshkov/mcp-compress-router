import type {
  AuthRequirement,
  AuthStatus,
  DownstreamServerConfig,
  Logger,
  StoredCredentials,
} from '../utils/index.js';
import { mutateCredentials } from '../cli/config-io.js';
import { credentialsUsableFor, resolveBindingUrl } from './credential-binding.js';
import { discoverAuth } from './oauth-discovery.js';

/**
 * Probes a downstream HTTP server to determine whether it advertises OAuth
 * support, following the MCP 2025-06-18 two-step flow: RFC 9728 Protected
 * Resource Metadata first, then RFC 8414 Authorization Server Metadata at
 * each advertised authorization server (with an origin-root fallback for
 * legacy servers).
 *
 * stdio servers never support OAuth, so they short-circuit to `'none'`
 * without any network access.
 *
 * @param server - Typed downstream server config.
 * @param logger - Optional logger for diagnostic output on probe errors.
 * @returns `'oauth'` when authorization-server metadata is advertised,
 *   `'none'` when it is absent, or `'unknown'` on network/probe errors.
 * @internal Exported for tests only; not part of the public module API.
 */
export async function probeAuthRequirement(
  server: DownstreamServerConfig,
  logger?: Logger,
): Promise<AuthRequirement> {
  if (server.type === 'stdio') {
    return 'none';
  }

  if (!server.url) {
    return 'unknown';
  }

  try {
    const discovered = await discoverAuth(new URL(server.url));
    return discovered.serverMetadata ? 'oauth' : 'none';
  } catch (err) {
    logger?.error(`Failed to probe OAuth metadata for "${server.name}"`, {
      server: server.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'unknown';
  }
}

/**
 * Determines the final display auth status for a server using only
 * local (non-network) information: the cached auth requirement from
 * `credentials.json`, any stored tokens, and configured HTTP headers.
 *
 * @param server - Typed downstream server config.
 * @param stored - The server's entry from `credentials.json`, or
 *   `undefined` when no entry exists.
 * @returns The auth status label shown in the `list` table.
 */
export function computeAuthStatus(
  server: DownstreamServerConfig,
  stored?: StoredCredentials,
): AuthStatus {
  if (server.type === 'stdio') {
    return 'none';
  }

  // A static Authorization header takes precedence over OAuth state.
  if (hasAuthorizationHeader(server.headers)) {
    return 'header';
  }

  const requirement: AuthRequirement = stored?.authRequirement ?? 'unknown';
  // Tokens bound to a different server URL do not count: the server
  // needs a fresh login before it can be used.
  const hasTokens =
    Boolean(stored?.tokens?.access_token) && credentialsUsableFor(stored, server.url);

  switch (requirement) {
    case 'oauth':
      return hasTokens ? 'authenticated' : 'requires login';
    case 'none':
      return 'public';
    case 'unknown':
      return 'unknown';
  }
}

/**
 * Returns true when the headers map contains an `Authorization` header
 * (case-insensitive key match).
 *
 * @param headers - Optional HTTP headers map.
 */
function hasAuthorizationHeader(headers?: Record<string, string>): boolean {
  if (!headers) {
    return false;
  }
  return Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
}

/**
 * Probes every HTTP downstream server for OAuth metadata and caches the
 * result in `credentials.json` so the `list` command can show auth
 * status without any network access. stdio servers are skipped (they
 * never support OAuth). Probe errors are recorded as `'unknown'` so a
 * single flaky server never blocks startup.
 *
 * The network probes run in parallel for speed; each credential entry is
 * then updated through a cross-process-locked read-modify-write, so a
 * token refresh that lands while the probes are in flight is merged into
 * the entry instead of being overwritten by a stale snapshot. Each
 * entry's server-URL binding is backfilled from the probed server when it
 * has none yet; an existing binding is preserved so a URL change never
 * re-binds old credentials to the new server.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param servers - Typed downstream server configs.
 * @param logger - Logger for diagnostic output.
 */
export async function persistAuthRequirements(
  configPath: string,
  servers: DownstreamServerConfig[],
  logger: Logger,
): Promise<void> {
  const httpServers = servers.filter((server) => server.type !== 'stdio');

  // Network-bound: probe in parallel for speed.
  const results = await Promise.all(
    httpServers.map(async (server) => ({
      name: server.name,
      requirement: await probeAuthRequirement(server, logger),
      serverUrl: server.url,
    })),
  );

  const checkedAt = new Date().toISOString();

  // Each entry is updated from its current on-disk state under the
  // credentials lock, preserving anything written in the meantime.
  for (const { name, requirement, serverUrl } of results) {
    await mutateCredentials(
      configPath,
      name,
      (current) => {
        const boundUrl = resolveBindingUrl(current, serverUrl);
        return {
          ...current,
          ...(boundUrl !== undefined ? { serverUrl: boundUrl } : {}),
          authRequirement: requirement,
          checkedAt,
        };
      },
      logger,
    );
  }

  logger.debug('Cached auth requirements', {
    servers: Object.fromEntries(results.map((r) => [r.name, r.requirement])),
  });
}
