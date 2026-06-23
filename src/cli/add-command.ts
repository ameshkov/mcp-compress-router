import {
  ensureConfigDir,
  readConfigFile,
  writeConfigFile,
  readCredentials,
  writeCredentials,
  type RawServerEntry,
} from './config-io.js';
import type { AuthRequirement } from '../utils/index.js';

/**
 * Options for the add subcommand, parsed from CLI flags.
 * @internal — Exported for tests only; not part of the public module API.
 */
export interface AddOptions {
  name: string;
  transport: string;
  commandOrUrl: string;
  /** Additional positional args after commandOrUrl. */
  rest?: string[];
  /** Environment variables from repeated -e flags. */
  env?: Record<string, string>;
  /** HTTP headers from repeated --header flags. */
  headers?: Record<string, string>;
}

/**
 * Handles the `add <name> <commandOrUrl> [args...]` subcommand.
 *
 * - If commandOrUrl starts with http:// or https://, auto-detects as HTTP.
 * - Otherwise treats it as a stdio command.
 * - Writes the entry to the mcpServers object and saves the config file.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param opts - Parsed CLI options.
 * @returns Human-readable confirmation message.
 * @throws If the server name already exists.
 */
export async function handleAdd(configPath: string, opts: AddOptions): Promise<string> {
  await ensureConfigDir(configPath);
  const servers = await readConfigFile(configPath);

  if (opts.name in servers) {
    throw new Error(
      `Server "${opts.name}" already exists. Use "remove ${opts.name}" first to replace it.`,
    );
  }

  // Auto-detect HTTP from URL pattern
  const isUrl = opts.commandOrUrl.startsWith('http://') || opts.commandOrUrl.startsWith('https://');
  const type = isUrl ? 'http' : opts.transport;

  const entry: RawServerEntry = { type };

  if (type === 'http') {
    entry.url = opts.commandOrUrl;
    if (opts.headers && Object.keys(opts.headers).length > 0) {
      entry.headers = opts.headers;
    }
  } else {
    entry.command = opts.commandOrUrl;
    if (opts.rest && opts.rest.length > 0) {
      entry.args = opts.rest;
    }
    if (opts.env && Object.keys(opts.env).length > 0) {
      entry.env = opts.env;
    }
  }

  servers[opts.name] = entry;
  await writeConfigFile(configPath, servers);

  let result = `Added server "${opts.name}" (${type}).`;

  // For HTTP servers, proactively check whether the server advertises
  // OAuth metadata. If it does, start the login flow automatically so
  // the user is not left with an unauthenticated server.
  if (type === 'http') {
    try {
      const loginResult = await tryAutoLogin(configPath, opts.name, opts.commandOrUrl);
      if (loginResult) {
        result += `\n${loginResult}`;
      }
    } catch {
      // Best-effort — don't block add on auto-login failure
    }
  }

  return result;
}

/**
 * Probes the server for OAuth metadata and, if found, runs the login
 * flow automatically. The probed auth requirement is cached in
 * `credentials.json` regardless of the login outcome so the `list`
 * command can show auth status without re-probing.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name just added.
 * @param url - Server URL to probe for OAuth metadata.
 * @returns The login confirmation message, or undefined if the server
 * does not advertise OAuth (or the probe failed).
 */
async function tryAutoLogin(
  configPath: string,
  name: string,
  url: string,
): Promise<string | undefined> {
  const { discoverAuthorizationServerMetadata } =
    await import('@modelcontextprotocol/sdk/client/auth.js');

  let requirement: AuthRequirement;
  let hasOAuth: boolean;
  try {
    const metadata = await discoverAuthorizationServerMetadata(new URL(url));
    hasOAuth = metadata !== undefined;
    requirement = hasOAuth ? 'oauth' : 'none';
  } catch {
    // Probe failed — cache 'unknown' and don't block the add.
    await persistAuthRequirement(configPath, name, 'unknown');
    return undefined;
  }

  // Cache the requirement regardless of the login outcome.
  await persistAuthRequirement(configPath, name, requirement);

  if (!hasOAuth) {
    return undefined;
  }

  const { handleLogin } = await import('./login-command.js');
  return handleLogin(configPath, name);
}

/**
 * Caches the probed auth requirement for a server in credentials.json,
 * preserving any previously stored tokens or client registration.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name.
 * @param requirement - The probed auth requirement to cache.
 */
async function persistAuthRequirement(
  configPath: string,
  name: string,
  requirement: AuthRequirement,
): Promise<void> {
  const existing = await readCredentials(configPath);
  await writeCredentials(configPath, name, {
    ...existing[name],
    authRequirement: requirement,
    checkedAt: new Date().toISOString(),
  });
}
