import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMockServers, buildRouterServer, writeRouterConfig } from './servers.js';
import type { RunPaths } from './types.js';

/**
 * Builds a run layout under a temporary directory.
 *
 * @param runDir - The temporary run directory.
 * @returns The run paths.
 */
function runPaths(runDir: string): RunPaths {
  return {
    repoRoot: '/app',
    runDir,
    workspaceDir: join(runDir, 'workspace'),
    homeDir: join(runDir, 'home'),
    configDir: join(runDir, 'agent-config'),
    routerHomeDir: join(runDir, 'router-home'),
    invocationLog: join(runDir, 'mcp-invocations.ndjson'),
  };
}

describe('benchmark server specs', () => {
  it('builds one absolute mock spec per server', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'bench-servers-test-'));
    try {
      const paths = runPaths(runDir);
      const servers = buildMockServers(paths);
      expect(servers.map((server) => server.name)).toEqual([
        'notion',
        'github',
        'figma',
        'playwright',
      ]);
      for (const server of servers) {
        expect(server.command).toBe('tsx');
        expect(server.args).toEqual([
          '/app/bench/scripts/mock-mcp/server.ts',
          '--server',
          server.name,
        ]);
        expect(server.env.MOCK_MCP_LOG).toBe(paths.invocationLog);
      }
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('builds the router spec against the compiled entry point', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'bench-servers-test-'));
    try {
      const paths = runPaths(runDir);
      const server = buildRouterServer(paths);
      expect(server.name).toBe('mcp-compress-router');
      expect(server.command).toBe('node');
      expect(server.args).toEqual(['/app/build/index.js']);
      expect(server.env.MCP_COMPRESS_ROUTER_HOME).toBe(paths.routerHomeDir);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('writes a router config with the same downstream servers', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'bench-servers-test-'));
    try {
      const paths = runPaths(runDir);
      const servers = buildMockServers(paths);
      const configPath = await writeRouterConfig(paths, servers);
      expect(configPath).toBe(join(paths.routerHomeDir, 'mcp.json'));
      const document = JSON.parse(await readFile(configPath, 'utf8')) as {
        mcpServers: Record<string, { type: string; command: string; args: string[] }>;
      };
      expect(Object.keys(document.mcpServers)).toEqual(['notion', 'github', 'figma', 'playwright']);
      expect(document.mcpServers.notion?.type).toBe('stdio');
      expect(document.mcpServers.notion?.command).toBe('tsx');
      expect(document.mcpServers.notion?.args).toEqual(servers[0]?.args);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});
