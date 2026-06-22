import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import type { DownstreamServerConfig, OAuthConfig, ServerTransportType } from '../utils/index.js';
import { expandEnvField, parseJsonc } from '../utils/index.js';

/** Recognized MCP transport types. */
const VALID_TYPES = new Set<string>(['stdio', 'http', 'streamable-http']);

/** Per-application directory name used inside the user data folder. */
const APP_DIR_NAME = 'mcp-compress-router';

/**
 * Resolves the base configuration directory.
 *
 * Priority: (1) MCP_COMPRESS_ROUTER_HOME env var, (2) the
 * platform-specific default (see {@link defaultConfigDir}). This is a
 * synchronous function that only reads environment variables and
 * performs path operations.
 *
 * @returns The absolute path to the configuration directory.
 */
export function resolveConfigDir(): string {
  return process.env.MCP_COMPRESS_ROUTER_HOME ?? defaultConfigDir();
}

/**
 * Returns the platform-specific default configuration directory.
 *
 * - Windows (`win32`): `%APPDATA%\mcp-compress-router` (falls back to
 *   `%USERPROFILE%\AppData\Roaming\mcp-compress-router` when `APPDATA`
 *   is unset).
 * - macOS (`darwin`): `~/Library/Application Support/mcp-compress-router`.
 * - Linux and other Unixes: `~/.local/share/mcp-compress-router`
 *   (XDG Base Directory style).
 *
 * The function is pure and side-effect free so it can be unit tested
 * for every platform regardless of the host the tests run on.
 *
 * @param platform - The Node platform identifier. Defaults to the host's.
 * @param home - The user home directory. Defaults to the host's.
 * @param appData - The Windows `%APPDATA%` path. Defaults to the env var.
 * @returns The absolute path to the default configuration directory.
 * @internal Exported for tests only; not part of the public module API.
 */
export function defaultConfigDir(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  appData: string | undefined = process.env.APPDATA,
): string {
  switch (platform) {
    case 'win32':
      return path.join(appData ?? path.join(home, 'AppData', 'Roaming'), APP_DIR_NAME);
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', APP_DIR_NAME);
    default:
      return path.join(home, '.local', 'share', APP_DIR_NAME);
  }
}

/**
 * Resolves the configuration file path.
 *
 * Priority: (1) explicit path argument, (2) MCP_COMPRESS_ROUTER_HOME env var,
 * (3) the platform-specific default (see {@link defaultConfigDir}). Within the
 * resolved directory, `mcp.jsonc` is preferred over `mcp.json` when both exist.
 * If neither exists, returns `mcp.json` (created on first use).
 *
 * @param explicitPath - An explicit config path, or undefined.
 * @returns The resolved absolute path to the config file.
 */
export async function resolveConfigPath(explicitPath: string | undefined): Promise<string> {
  if (explicitPath !== undefined) {
    return explicitPath;
  }
  return resolveDirectoryConfig(resolveConfigDir());
}

/**
 * Returns the existing mcp.jsonc or mcp.json path from a directory,
 * preferring jsonc. When neither file exists, returns mcp.json.
 */
async function resolveDirectoryConfig(dir: string): Promise<string> {
  const jsoncPath = path.join(dir, 'mcp.jsonc');
  const jsonPath = path.join(dir, 'mcp.json');
  if (await pathExists(jsoncPath)) return jsoncPath;
  if (await pathExists(jsonPath)) return jsonPath;
  return jsonPath;
}

/**
 * Checks whether a file exists at the given path.
 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates the "type" field and per-type required fields for a server.
 *
 * @param name - Server name (for error messages).
 * @param server - The server entry object from mcp.json.
 * @returns The validated transport type.
 * @throws If type is missing, unsupported, or required fields are absent.
 */
function validateServerType(name: string, server: Record<string, unknown>): ServerTransportType {
  const rawType = server.type;
  if (typeof rawType !== 'string' || rawType.length === 0) {
    throw new Error(
      `Server "${name}" is missing required "type" field. Must be one of: ${[...VALID_TYPES].join(', ')}`,
    );
  }
  if (!VALID_TYPES.has(rawType)) {
    throw new Error(
      `Server "${name}" has unsupported type "${rawType}". Must be one of: ${[...VALID_TYPES].join(', ')}`,
    );
  }
  const type = rawType as ServerTransportType;

  if (type === 'stdio') {
    if (typeof server.command !== 'string' || server.command.length === 0) {
      throw new Error(`Server "${name}" (stdio) is missing required "command" field`);
    }
  } else {
    if (typeof server.url !== 'string' || server.url.length === 0) {
      throw new Error(`Server "${name}" (${type}) is missing required "url" field`);
    }
  }

  return type;
}

/**
 * Converts a Record<string, unknown> to Record<string, string> by coercing
 * each value to a string, or returns undefined when the input is missing.
 *
 * @param obj - The raw object or undefined/null.
 * @returns The string map or undefined.
 */
function toStringMap(obj: unknown): Record<string, string> | undefined {
  if (obj === undefined || obj === null || typeof obj !== 'object') {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
  );
}

/**
 * Expands env vars in every value of a string map.
 *
 * @param map - The string map to expand.
 * @param keyContext - Context prefix for expansion error messages (e.g. "env").
 * @param entryContext - Server-level context (e.g. 'server "github"').
 * @returns The expanded string map.
 */
function expandStringMap(
  map: Record<string, string>,
  keyContext: string,
  entryContext: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(map).map(([k, v]) => [
      k,
      expandEnvField(v, `${entryContext} ${keyContext}.${k}`),
    ]),
  );
}

/**
 * Extracts and expands raw fields from a server entry.
 *
 * @param entryContext - Human-readable context string for env var expansion.
 * @param server - The server entry object from mcp.json.
 * @returns An object containing expanded command, args, env, url, and headers.
 */
function buildServerFields(
  entryContext: string,
  server: Record<string, unknown>,
): {
  command: string | undefined;
  args: string[] | undefined;
  env: Record<string, string> | undefined;
  url: string | undefined;
  headers: Record<string, string> | undefined;
} {
  const rawCommand = typeof server.command === 'string' ? server.command : undefined;
  const rawArgs: string[] | undefined = Array.isArray(server.args)
    ? server.args.map(String)
    : undefined;
  const rawEnv = toStringMap(server.env);
  const rawUrl = typeof server.url === 'string' ? server.url : undefined;
  const rawHeaders = toStringMap(server.headers);

  const command =
    rawCommand !== undefined ? expandEnvField(rawCommand, `${entryContext} command`) : undefined;
  const args = rawArgs?.map((a, i) => expandEnvField(a, `${entryContext} args[${i}]`));
  const env = rawEnv !== undefined ? expandStringMap(rawEnv, 'env', entryContext) : undefined;
  const url = rawUrl !== undefined ? expandEnvField(rawUrl, `${entryContext} url`) : undefined;
  const headers =
    rawHeaders !== undefined ? expandStringMap(rawHeaders, 'headers', entryContext) : undefined;

  return { command, args, env, url, headers };
}

/**
 * Parses the optional `oauth` block from a server entry with env expansion.
 *
 * @param entryContext - Human-readable context string for env var expansion.
 * @param server - The server entry object from mcp.json.
 * @returns The parsed OAuth config, or undefined if absent.
 * @throws If the oauth block is not an object.
 */
function parseOauthBlock(
  entryContext: string,
  server: Record<string, unknown>,
): OAuthConfig | undefined {
  if (server.oauth === undefined || server.oauth === null) {
    return undefined;
  }
  if (typeof server.oauth !== 'object') {
    throw new Error(`Server "${entryContext.slice(8)}" oauth block must be an object`);
  }

  const oauthRaw = server.oauth as Record<string, unknown>;
  const rawClientId = typeof oauthRaw.clientId === 'string' ? oauthRaw.clientId : undefined;
  const rawClientSecret =
    typeof oauthRaw.clientSecret === 'string' ? oauthRaw.clientSecret : undefined;
  const rawScope = typeof oauthRaw.scope === 'string' ? oauthRaw.scope : undefined;

  const clientId =
    rawClientId !== undefined
      ? expandEnvField(rawClientId, `${entryContext} oauth.clientId`)
      : undefined;
  const clientSecret =
    rawClientSecret !== undefined
      ? expandEnvField(rawClientSecret, `${entryContext} oauth.clientSecret`)
      : undefined;
  const scope =
    rawScope !== undefined ? expandEnvField(rawScope, `${entryContext} oauth.scope`) : undefined;

  const oauth: OAuthConfig = {};
  if (clientId !== undefined) oauth.clientId = clientId;
  if (clientSecret !== undefined) oauth.clientSecret = clientSecret;
  if (scope !== undefined) oauth.scope = scope;
  return oauth;
}

/**
 * Parses a single server entry from the mcpServers object.
 *
 * Orchestrates validation, field extraction, and env var expansion for
 * one named server entry, then returns the resulting config object.
 *
 * @param name - Server name (key in mcpServers).
 * @param entry - The raw server value.
 * @param names - Set of already-seen names for duplicate detection.
 * @returns A validated DownstreamServerConfig.
 * @throws If the entry is invalid or the name is a duplicate.
 */
function parseServerEntry(
  name: string,
  entry: unknown,
  names: Set<string>,
): DownstreamServerConfig {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`Server "${name}" must be an object`);
  }

  const server = entry as Record<string, unknown>;
  const type = validateServerType(name, server);

  if (names.has(name)) {
    throw new Error(`Duplicate server name: "${name}"`);
  }
  names.add(name);

  const entryContext = `server "${name}"`;
  const fields = buildServerFields(entryContext, server);
  const description = typeof server.description === 'string' ? server.description : undefined;
  const oauth = parseOauthBlock(entryContext, server);

  return { name, type, ...fields, description, oauth };
}

/**
 * Loads and validates the MCP configuration file.
 *
 * Reads a JSON file with a top-level mcpServers object, extracts stdio
 * entries, and validates uniqueness. HTTP servers and variable expansion
 * are deferred to later slices.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @returns An array of validated DownstreamServerConfig objects.
 * @throws If the file is missing, invalid JSON, contains duplicate names,
 *   or contains zero servers (the router has nothing to route).
 */
export async function loadConfig(configPath: string): Promise<DownstreamServerConfig[]> {
  const raw = await fs.readFile(configPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw, configPath);
  } catch {
    throw new Error(`Failed to parse config file: ${configPath}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Config file must contain a JSON object with mcpServers');
  }

  const obj = parsed as Record<string, unknown>;
  const mcpServers = obj.mcpServers;
  if (typeof mcpServers !== 'object' || mcpServers === null) {
    throw new Error('Config file must contain an mcpServers object');
  }

  const names = new Set<string>();
  const servers: DownstreamServerConfig[] = [];

  for (const [name, entry] of Object.entries(mcpServers as Record<string, unknown>)) {
    servers.push(parseServerEntry(name, entry, names));
  }

  if (servers.length === 0) {
    throw new Error(
      'Configuration contains no downstream MCP servers. Add at least one ' +
        'server before starting the router (e.g. via the "add" subcommand).',
    );
  }

  return servers;
}
