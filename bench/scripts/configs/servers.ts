/**
 * MCP server specifications for the benchmark.
 *
 * Both benchmark modes expose the same four mock servers; only the
 * connection path differs. In `direct` mode the agent spawns all four
 * servers itself; in `router` mode the agent spawns only
 * mcp-compress-router, which spawns the same four servers as downstreams.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MOCK_SERVER_NAMES } from '../mock-mcp/registry.js';
import type { McpServerSpec, RunPaths } from './types.js';

/** Path of the mock MCP stdio server inside the repository. */
const MOCK_SERVER_SCRIPT = 'bench/scripts/mock-mcp/server.ts';

/** Path of the compiled router entry point inside the repository. */
const ROUTER_ENTRY = 'build/index.js';

/**
 * Builds the four mock MCP server specs for one run.
 *
 * Absolute paths are used for the script and the invocation log so the
 * specs work regardless of the working directory the agent or the
 * router spawns them from.
 *
 * @param paths - The run directory layout.
 * @returns One spec per mock server.
 */
export function buildMockServers(paths: RunPaths): McpServerSpec[] {
  return MOCK_SERVER_NAMES.map((name) => ({
    name,
    command: 'tsx',
    args: [join(paths.repoRoot, MOCK_SERVER_SCRIPT), '--server', name],
    env: { MOCK_MCP_LOG: paths.invocationLog },
    description: `Benchmark stub for the ${name} MCP server surface`,
  }));
}

/**
 * Builds the mcp-compress-router server spec for one run.
 *
 * @param paths - The run directory layout.
 * @returns The router spec.
 */
export function buildRouterServer(paths: RunPaths): McpServerSpec {
  return {
    name: 'mcp-compress-router',
    command: 'node',
    args: [join(paths.repoRoot, ROUTER_ENTRY)],
    env: { MCP_COMPRESS_ROUTER_HOME: paths.routerHomeDir },
    description: 'mcp-compress-router compressing the benchmark mock servers',
  };
}

/**
 * Writes the router's `mcp.json` listing the mock downstream servers.
 *
 * The file uses the same server entries the direct mode hands to the
 * agent, so both modes talk to identical mock servers.
 *
 * @param paths - The run directory layout.
 * @param servers - The mock downstream server specs.
 * @returns The absolute path of the written config file.
 */
export async function writeRouterConfig(
  paths: RunPaths,
  servers: McpServerSpec[],
): Promise<string> {
  await mkdir(paths.routerHomeDir, { recursive: true });
  const configPath = join(paths.routerHomeDir, 'mcp.json');
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      type: 'stdio',
      command: server.command,
      args: server.args,
      env: server.env,
      description: server.description,
    };
  }
  await writeFile(configPath, `${JSON.stringify({ mcpServers }, null, 2)}\n`, 'utf8');
  return configPath;
}
