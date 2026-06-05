import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import type { DownstreamServerConfig } from '../utils/index.js';

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

  for (const [name, entry] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Server "${name}" must be an object`);
    }

    const server = entry as Record<string, unknown>;

    if (server.type !== 'stdio') {
      throw new Error(
        `Server "${name}" has unsupported type "${String(server.type)}"; only "stdio" is supported`,
      );
    }

    if (typeof server.command !== 'string' || server.command.length === 0) {
      throw new Error(`Server "${name}" is missing required "command" field`);
    }

    if (names.has(name)) {
      throw new Error(`Duplicate server name: "${name}"`);
    }
    names.add(name);

    const args = Array.isArray(server.args) ? server.args.map(String) : undefined;

    const env =
      server.env !== undefined && typeof server.env === 'object'
        ? Object.fromEntries(
            Object.entries(server.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          )
        : undefined;

    const description = typeof server.description === 'string' ? server.description : undefined;

    servers.push({
      name,
      command: server.command as string,
      args,
      env,
      description,
    });
  }

  return servers;
}
