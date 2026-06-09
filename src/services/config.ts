import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import type { DownstreamServerConfig, ServerTransportType } from '../utils/index.js';
import { expandEnvField } from '../utils/index.js';

/**
 * Resolves the configuration file path.
 *
 * Priority: (1) explicit path argument, (2) MCP_COMPRESS_ROUTER_HOME env var,
 * (3) default ~/.local/share/mcp-compress-router/mcp.json.
 *
 * @param explicitPath - An explicit config path, or undefined.
 * @returns The resolved absolute path to the config file.
 */
export function resolveConfigPath(explicitPath: string | undefined): string {
  if (explicitPath !== undefined) {
    return explicitPath;
  }
  const home =
    process.env.MCP_COMPRESS_ROUTER_HOME ??
    path.join(os.homedir(), '.local', 'share', 'mcp-compress-router');
  return path.join(home, 'mcp.json');
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
 * @throws If the file is missing, invalid JSON, or contains duplicate names.
 */
export async function loadConfig(configPath: string): Promise<DownstreamServerConfig[]> {
  const raw = await fs.readFile(configPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
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
  const validTypes = new Set<string>(['stdio', 'http', 'streamable-http']);

  for (const [name, entry] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Server "${name}" must be an object`);
    }

    const server = entry as Record<string, unknown>;

    // --- Type validation ---
    const rawType = server.type;
    if (typeof rawType !== 'string' || rawType.length === 0) {
      throw new Error(
        `Server "${name}" is missing required "type" field. Must be one of: ${[...validTypes].join(', ')}`,
      );
    }
    if (!validTypes.has(rawType)) {
      throw new Error(
        `Server "${name}" has unsupported type "${rawType}". Must be one of: ${[...validTypes].join(', ')}`,
      );
    }
    const type = rawType as ServerTransportType;

    // --- Per-type required field validation ---
    if (type === 'stdio') {
      if (typeof server.command !== 'string' || server.command.length === 0) {
        throw new Error(`Server "${name}" (stdio) is missing required "command" field`);
      }
    } else {
      // http or streamable-http
      if (typeof server.url !== 'string' || server.url.length === 0) {
        throw new Error(`Server "${name}" (${type}) is missing required "url" field`);
      }
    }

    // --- Duplicate name check ---
    if (names.has(name)) {
      throw new Error(`Duplicate server name: "${name}"`);
    }
    names.add(name);

    // --- Extract raw field values ---
    const rawCommand = typeof server.command === 'string' ? server.command : undefined;
    const rawArgs: string[] | undefined = Array.isArray(server.args)
      ? server.args.map(String)
      : undefined;
    const rawEnv: Record<string, string> | undefined =
      server.env !== undefined && typeof server.env === 'object'
        ? Object.fromEntries(
            Object.entries(server.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          )
        : undefined;
    const rawUrl = typeof server.url === 'string' ? server.url : undefined;
    const rawHeaders: Record<string, string> | undefined =
      server.headers !== undefined && typeof server.headers === 'object'
        ? Object.fromEntries(
            Object.entries(server.headers as Record<string, unknown>).map(([k, v]) => [
              k,
              String(v),
            ]),
          )
        : undefined;
    const description = typeof server.description === 'string' ? server.description : undefined;

    // --- Env var expansion ---
    const entryContext = `server "${name}"`;

    const command =
      rawCommand !== undefined ? expandEnvField(rawCommand, `${entryContext} command`) : undefined;

    const args = rawArgs?.map((a, i) => expandEnvField(a, `${entryContext} args[${i}]`));

    const env =
      rawEnv !== undefined
        ? Object.fromEntries(
            Object.entries(rawEnv).map(([k, v]) => [
              k,
              expandEnvField(v, `${entryContext} env.${k}`),
            ]),
          )
        : undefined;

    const url = rawUrl !== undefined ? expandEnvField(rawUrl, `${entryContext} url`) : undefined;

    const headers =
      rawHeaders !== undefined
        ? Object.fromEntries(
            Object.entries(rawHeaders).map(([k, v]) => [
              k,
              expandEnvField(v, `${entryContext} headers.${k}`),
            ]),
          )
        : undefined;

    // --- Parse optional oauth block ---
    let oauth: { clientId?: string; clientSecret?: string; scope?: string } | undefined;
    if (server.oauth !== undefined && server.oauth !== null) {
      if (typeof server.oauth !== 'object') {
        throw new Error(`Server "${name}" oauth block must be an object`);
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
        rawScope !== undefined
          ? expandEnvField(rawScope, `${entryContext} oauth.scope`)
          : undefined;

      oauth = {};
      if (clientId !== undefined) oauth.clientId = clientId;
      if (clientSecret !== undefined) oauth.clientSecret = clientSecret;
      if (scope !== undefined) oauth.scope = scope;
    }

    servers.push({ name, type, command, args, env, url, headers, description, oauth });
  }

  return servers;
}
