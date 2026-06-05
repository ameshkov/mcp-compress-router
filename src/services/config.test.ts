import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfigPath, loadConfig } from './config.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { tmpdir } from 'node:os';

describe('resolveConfigPath', () => {
  const originalHome = process.env.MCP_COMPRESS_ROUTER_HOME;

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.MCP_COMPRESS_ROUTER_HOME = originalHome;
    } else {
      delete process.env.MCP_COMPRESS_ROUTER_HOME;
    }
  });

  it('returns the explicit path when provided', () => {
    expect(resolveConfigPath('/explicit/mcp.json')).toBe('/explicit/mcp.json');
  });

  it('returns the MCP_COMPRESS_ROUTER_HOME path when env var is set', () => {
    process.env.MCP_COMPRESS_ROUTER_HOME = '/custom/home';
    expect(resolveConfigPath(undefined)).toBe('/custom/home/mcp.json');
  });

  it('returns the default home path when no arg or env var', () => {
    delete process.env.MCP_COMPRESS_ROUTER_HOME;
    const home = os.homedir();
    const expected = path.join(home, '.local', 'share', 'mcp-compress-router', 'mcp.json');
    expect(resolveConfigPath(undefined)).toBe(expected);
  });
});

describe('loadConfig', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('loads stdio servers from mcpServers', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        server1: {
          type: 'stdio',
          command: 'node',
          args: ['./server1.js'],
        },
        server2: {
          type: 'stdio',
          command: '/usr/bin/python3',
          args: ['-m', 'my_mcp'],
          env: { FOO: 'bar' },
          description: 'A Python MCP server',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const servers = await loadConfig(configPath);
    expect(servers).toHaveLength(2);
    expect(servers[0]).toEqual({
      name: 'server1',
      command: 'node',
      args: ['./server1.js'],
      env: undefined,
      description: undefined,
    });
    expect(servers[1]).toEqual({
      name: 'server2',
      command: '/usr/bin/python3',
      args: ['-m', 'my_mcp'],
      env: { FOO: 'bar' },
      description: 'A Python MCP server',
    });
  });

  it('rejects config with missing command field', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        bad: { type: 'stdio' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    await expect(loadConfig(configPath)).rejects.toThrow(/command/);
  });

  it('rejects unsupported transport type', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        httpSrv: { type: 'http', command: 'node' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    await expect(loadConfig(configPath)).rejects.toThrow(/unsupported/);
  });
});
