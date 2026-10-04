import {
  ensureConfigDir,
  readConfigFile,
  writeConfigFile,
  mutateCredentials,
  type RawServerEntry,
} from './config-io.js';
import {
  normalizeDescription,
  SERVER_DESCRIPTION_GUIDANCE,
  validateGlobPattern,
  validateOAuthClientName,
  validateOAuthClientUri,
  type AuthRequirement,
} from '../utils/index.js';
import { discoverAuth, resolveBindingUrl } from '../services/index.js';
import { handleLogin } from './login-command.js';

/**
 * Options for the add subcommand, parsed from CLI flags.
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
  /** Server description exposed to the LLM via get_tool_schema to help
   *  it decide which server to route a request to. Required — checked by
   *  the handler before anything is written. */
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
  /**
   * Dynamic client registration `client_name` from `--client-name`.
   * Only applies to HTTP servers; persisted as `oauth.clientName` so
   * the automatic login registers with this identity.
   */
  clientName?: string;
  /**
   * Dynamic client registration `client_uri` from `--client-uri`. Only
   * applies to HTTP servers; persisted as `oauth.clientUri`.
   */
  clientUri?: string;
  /**
   * Set by `--no-browser`: print the authorization URL and read a
   * pasted redirect URL or authorization code during the automatic
   * login for OAuth servers instead of opening a browser.
   */
  noBrowser?: boolean;
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
      throw new Error(`Invalid "${field}" pattern "${pattern}": ${reason}`, { cause: err });
    }
  }
}

/**
 * Validates and normalizes the required server description option.
 *
 * The description is collapsed to a single line (interior whitespace
 * becomes single spaces) so a multi-line `--description` cannot render
 * as an extra catalog section.
 *
 * @param description - The raw `--description` value, if any.
 * @returns The normalized description.
 * @throws If the option is missing, empty, or whitespace-only.
 */
function resolveDescription(description: string | undefined): string {
  const normalized = normalizeDescription(description);
  if (!normalized) {
    throw new Error(`Missing the required --description option. ${SERVER_DESCRIPTION_GUIDANCE}`);
  }
  return normalized;
}

/**
 * Builds the raw server entry from parsed CLI options, including
 * transport auto-detection, env/headers, description, and the optional
 * enable/filter fields.
 *
 * @param opts - Parsed CLI options.
 * @param description - The validated server description.
 * @returns The constructed raw server entry and its resolved transport type.
 */
function buildServerEntry(
  opts: AddOptions,
  description: string,
): { entry: RawServerEntry; type: string } {
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

  entry.description = description;

  if (opts.disabled) {
    entry.enabled = false;
  }
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    entry.allowedTools = opts.allowedTools;
  }
  if (opts.disabledTools && opts.disabledTools.length > 0) {
    entry.disabledTools = opts.disabledTools;
  }

  // OAuth overrides only apply to HTTP servers (there is no callback or
  // dynamic registration for stdio). Persist them on the `oauth` block so
  // `login` reuses the same identity and redirect URI.
  const oauth = buildOAuthBlock(opts, type);
  if (oauth) {
    entry.oauth = oauth;
  }

  return { entry, type };
}

/**
 * Builds the optional `oauth` block from `--port`, `--client-name`, and
 * `--client-uri`.
 *
 * Each flag is HTTP-only and validated before it is written: the port
 * must be an integer in 1-65535, the client name non-empty, and the
 * client URI an absolute http(s) URL.
 *
 * @param opts - Parsed CLI options.
 * @param type - The resolved transport type.
 * @returns The raw oauth block, or undefined when no flag was passed.
 * @throws If a flag is used for a stdio server or carries an invalid value.
 */
function buildOAuthBlock(opts: AddOptions, type: string): Record<string, unknown> | undefined {
  if (opts.port !== undefined && type !== 'http') {
    throw new Error('--port is only supported for HTTP servers (OAuth callback).');
  }
  if (opts.clientName !== undefined && type !== 'http') {
    throw new Error('--client-name is only supported for HTTP servers (OAuth).');
  }
  if (opts.clientUri !== undefined && type !== 'http') {
    throw new Error('--client-uri is only supported for HTTP servers (OAuth).');
  }
  if (
    opts.port !== undefined &&
    (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)
  ) {
    throw new Error(`--port must be an integer between 1 and 65535 (got ${opts.port}).`);
  }

  const oauth: Record<string, unknown> = {};
  if (opts.clientName !== undefined) {
    oauth.clientName = validateOAuthClientName(opts.clientName, '--client-name');
  }
  if (opts.clientUri !== undefined) {
    oauth.clientUri = validateOAuthClientUri(opts.clientUri, '--client-uri');
  }
  if (opts.port !== undefined) {
    oauth.callbackPort = opts.port;
  }
  return Object.keys(oauth).length > 0 ? oauth : undefined;
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
 * @throws If the description is missing, the server name already exists,
 *   or an option is invalid.
 */
export async function handleAdd(configPath: string, opts: AddOptions): Promise<string> {
  if (opts.enabled && opts.disabled) {
    throw new Error('Cannot specify both --enabled and --disabled.');
  }

  validateToolListPatterns('allowedTools', opts.allowedTools);
  validateToolListPatterns('disabledTools', opts.disabledTools);
  const description = resolveDescription(opts.description);

  await ensureConfigDir(configPath);
  const servers = await readConfigFile(configPath);

  if (opts.name in servers) {
    throw new Error(
      `Server "${opts.name}" already exists. Use "remove ${opts.name}" first to replace it.`,
    );
  }

  const { entry, type } = buildServerEntry(opts, description);

  servers[opts.name] = entry;
  await writeConfigFile(configPath, servers);

  let result = `Added server "${opts.name}" (${type}).`;

  // For HTTP servers, proactively check whether the server advertises
  // OAuth metadata. If it does, start the login flow automatically so
  // the user is not left with an unauthenticated server.
  if (type === 'http') {
    try {
      const loginResult = await tryAutoLogin(
        configPath,
        opts.name,
        opts.commandOrUrl,
        opts.noBrowser,
      );
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
 * @param noBrowser - Skip the browser during the automatic login and
 * accept a pasted redirect URL or authorization code instead.
 * @returns The login confirmation message, or undefined if the server
 * does not advertise OAuth (or the probe failed).
 */
async function tryAutoLogin(
  configPath: string,
  name: string,
  url: string,
  noBrowser?: boolean,
): Promise<string | undefined> {
  // Use the spec-compliant two-step discovery (RFC 9728 PRM, then RFC 8414
  // AS metadata at each advertised authorization server). A one-step
  // `discoverAuthorizationServerMetadata` probe misses servers that
  // publish their AS only via PRM `authorization_servers` (e.g. Notion,
  // whose AS metadata lives at the origin root, not the path-qualified
  // well-known URL).
  let requirement: AuthRequirement;
  let hasOAuth: boolean;
  try {
    const discovered = await discoverAuth(new URL(url));
    hasOAuth = Boolean(discovered.serverMetadata);
    requirement = hasOAuth ? 'oauth' : 'none';
  } catch {
    // Probe failed — cache 'unknown' and don't block the add.
    await persistAuthRequirement(configPath, name, url, 'unknown');
    return undefined;
  }

  // Cache the requirement regardless of the login outcome.
  await persistAuthRequirement(configPath, name, url, requirement);

  if (!hasOAuth) {
    return undefined;
  }

  return handleLogin(configPath, name, { noBrowser });
}

/**
 * Caches the probed auth requirement for a server in credentials.json,
 * preserving any previously stored tokens or client registration.
 *
 * The entry's server-URL binding is backfilled from the probed URL when
 * it has none yet; an existing binding is preserved so a URL change
 * never re-binds old credentials to the new server.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name.
 * @param url - The server URL the probe ran against.
 * @param requirement - The probed auth requirement to cache.
 */
async function persistAuthRequirement(
  configPath: string,
  name: string,
  url: string,
  requirement: AuthRequirement,
): Promise<void> {
  await mutateCredentials(configPath, name, (current) => {
    const serverUrl = resolveBindingUrl(current, url);
    return {
      ...current,
      ...(serverUrl !== undefined ? { serverUrl } : {}),
      authRequirement: requirement,
      checkedAt: new Date().toISOString(),
    };
  });
}
