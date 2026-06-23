import type {
  AuthRequirement,
  AuthStatus,
  DownstreamServerConfig,
  Logger,
  StoredCredentials,
} from '../utils/index.js';
import { readCredentials, writeCredentials } from '../cli/config-io.js';

/**
 * Probes a downstream HTTP server's OAuth discovery endpoint to
 * determine whether it advertises OAuth support. Makes a single probe
 * of the server's well-known authorization-server metadata.
 *
 * stdio servers never support OAuth, so they short-circuit to `'none'`
 * without any network access.
 *
 * @param server - Typed downstream server config.
 * @param logger - Optional logger for diagnostic output on probe errors.
 * @returns `'oauth'` when metadata is advertised, `'none'` when it is
 *   absent, or `'unknown'` on network/probe errors.
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
    const { discoverAuthorizationServerMetadata } =
      await import('@modelcontextprotocol/sdk/client/auth.js');
    const metadata = await discoverAuthorizationServerMetadata(new URL(server.url));
    return metadata ? 'oauth' : 'none';
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
  const hasTokens = Boolean(stored?.tokens?.access_token);

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
 * The network probes run in parallel for speed, but the credential file
 * writes are serialized to avoid concurrent read-modify-write races.
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
  // Read the existing store once so per-server tokens and client
  // registration survive the auth-requirement update.
  const existing = await readCredentials(configPath);

  const httpServers = servers.filter((server) => server.type !== 'stdio');

  // Network-bound: probe in parallel for speed.
  const results = await Promise.all(
    httpServers.map(async (server) => ({
      name: server.name,
      requirement: await probeAuthRequirement(server, logger),
    })),
  );

  const checkedAt = new Date().toISOString();

  // Serialize writes to avoid concurrent file read-modify-write races.
  for (const { name, requirement } of results) {
    await writeCredentials(configPath, name, {
      ...existing[name],
      authRequirement: requirement,
      checkedAt,
    });
  }

  logger.debug('Cached auth requirements', {
    servers: Object.fromEntries(results.map((r) => [r.name, r.requirement])),
  });
}
