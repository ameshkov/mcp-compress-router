import {
  ensureConfigDir,
  readConfigFile,
  writeConfigFile,
  readCredentials,
  writeCredentials,
  type RawServerEntry,
} from './config-io.js';
import {
  isCompressionLevel,
  validateGlobPattern,
  VALID_COMPRESSION_LEVELS,
  type AuthRequirement,
} from '../utils/index.js';

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
  /** Optional server description exposed to the LLM via get_tool_schema
   *  to help it decide which server to route a request to. */
  description?: string;
  /** Set true by --disabled (writes "enabled": false). */
  disabled?: boolean;
  /** Set true by --enabled (writes nothing; omitted = enabled). */
  enabled?: boolean;
  /** Ordered glob patterns from repeatable --allowed-tools. */
  allowedTools?: string[];
  /** Ordered glob patterns from repeatable --disabled-tools. */
  disabledTools?: string[];
  /**
   * Fixed local OAuth callback port from `--port`. Only applies to HTTP
   * servers; persisted as `oauth.callbackPort` so subsequent `login`
   * runs reuse it.
   */
  port?: number;
  /** Compression level from `--compression-level`; undefined writes no field. */
  compressionLevel?: string;
}

/**
 * Validates every glob pattern in an optional tool list, throwing with
 * the field name and offending pattern on the first invalid entry.
 *
 * @param field - "allowedTools" or "disabledTools" (for the message).
 * @param patterns - Patterns to validate; undefined/empty is a no-op.
 * @throws If any pattern is rejected by picomatch.
 */
function validateToolListPatterns(
  field: 'allowedTools' | 'disabledTools',
  patterns: string[] | undefined,
): void {
  if (!patterns || patterns.length === 0) return;
  for (const pattern of patterns) {
    try {
      validateGlobPattern(pattern);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid "${field}" pattern "${pattern}": ${reason}`);
    }
  }
}

/**
 * Builds the raw server entry from parsed CLI options, including
 * transport auto-detection, env/headers, description, and the optional
 * enable/filter fields.
 *
 * @param opts - Parsed CLI options.
 * @returns The constructed raw server entry and its resolved transport type.
 */
function buildServerEntry(opts: AddOptions): { entry: RawServerEntry; type: string } {
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

  if (opts.description) {
    entry.description = opts.description;
  }

  if (opts.disabled) {
    entry.enabled = false;
  }
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    entry.allowedTools = opts.allowedTools;
  }
  if (opts.disabledTools && opts.disabledTools.length > 0) {
    entry.disabledTools = opts.disabledTools;
  }

  if (opts.compressionLevel) {
    entry.compressionLevel = opts.compressionLevel;
  }

  // A fixed callback port only applies to HTTP servers (OAuth). Persist
  // it on the `oauth` block so `login` reuses the same redirect URI.
  if (opts.port !== undefined) {
    if (type !== 'http') {
      throw new Error('--port is only supported for HTTP servers (OAuth callback).');
    }
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
      throw new Error(`--port must be an integer between 1 and 65535 (got ${opts.port}).`);
    }
    entry.oauth = { callbackPort: opts.port };
  }

  return { entry, type };
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
  if (opts.enabled && opts.disabled) {
    throw new Error('Cannot specify both --enabled and --disabled.');
  }

  validateToolListPatterns('allowedTools', opts.allowedTools);
  validateToolListPatterns('disabledTools', opts.disabledTools);

  if (opts.compressionLevel !== undefined && !isCompressionLevel(opts.compressionLevel)) {
    throw new Error(
      `Invalid "--compression-level" value "${opts.compressionLevel}": ` +
        `must be one of ${VALID_COMPRESSION_LEVELS.join(', ')}.`,
    );
  }

  await ensureConfigDir(configPath);
  const servers = await readConfigFile(configPath);

  if (opts.name in servers) {
    throw new Error(
      `Server "${opts.name}" already exists. Use "remove ${opts.name}" first to replace it.`,
    );
  }

  const { entry, type } = buildServerEntry(opts);

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
 * Probes the server for OAuth metadata using the spec-compliant two-step
 * discovery flow (RFC 9728 Protected Resource Metadata, then RFC 8414
 * Authorization Server Metadata at each advertised authorization server)
 * and, if OAuth is advertised, runs the login flow automatically. The
 * probed auth requirement is cached in `credentials.json` regardless of
 * the login outcome so the `list` command can show auth status without
 * re-probing.
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
  // Use the spec-compliant two-step discovery (RFC 9728 PRM, then RFC 8414
  // AS metadata at each advertised authorization server). A one-step
  // `discoverAuthorizationServerMetadata` probe misses servers that
  // publish their AS only via PRM `authorization_servers` (e.g. Notion,
  // whose AS metadata lives at the origin root, not the path-qualified
  // well-known URL).
  const { discoverAuth } = await import('../services/oauth-discovery.js');

  let requirement: AuthRequirement;
  let hasOAuth: boolean;
  try {
    const discovered = await discoverAuth(new URL(url));
    hasOAuth = Boolean(discovered.serverMetadata);
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
