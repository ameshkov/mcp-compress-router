import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { routerPath } from './helpers.js';
import { createAuthFixtureServer } from '../fixture-auth-server.js';
import type { AuthFixtureServer } from '../fixture-auth-server.js';
import { spawnSync } from 'node:child_process';

describe('MCP Compress Router E2E — OAuth', () => {
  let authFixture: AuthFixtureServer;
  let tempDir: string;
  let configPath: string;

  beforeAll(async () => {
    authFixture = await createAuthFixtureServer();
  });

  afterAll(() => {
    authFixture.server.close();
  });

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `mcp-e2e-oauth-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });
    configPath = path.join(tempDir, 'mcp.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Helper: run a CLI subcommand of mcp-compress-router
  function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync('node', [routerPath, ...args], {
      env: { ...process.env, MCP_COMPRESS_ROUTER_HOME: tempDir },
      timeout: 10000,
    });
    return {
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      exitCode: result.status ?? -1,
    };
  }

  it('login for unknown server name returns guided error with no servers', () => {
    // ensureConfigDir creates mcpServers: {} if file doesn't exist
    const result = runCli(['login', 'unknown', '--config', configPath]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
    expect(result.stderr).toContain('No servers configured');
  });

  it('login with known config but unknown name returns guided error with available servers', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          github: { type: 'http', url: authFixture.url + '/mcp' },
        },
      }),
    );
    const result = runCli(['login', 'unknown', '--config', configPath]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
    expect(result.stderr).toContain('github');
  });

  it('login for stdio server returns guided error', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          local: { type: 'stdio', command: 'node' },
        },
      }),
    );
    const result = runCli(['login', 'local', '--config', configPath]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('OAuth is only supported for HTTP servers');
  });

  it('logout for unknown server name returns guided error', () => {
    const result = runCli(['logout', 'unknown', '--config', configPath]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
    expect(result.stderr).toContain('No servers configured');
  });

  it('logout with no stored credentials succeeds gracefully', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          github: { type: 'http', url: authFixture.url + '/mcp' },
        },
      }),
    );
    const result = runCli(['logout', 'github', '--config', configPath]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No credentials');
  });

  it('logout removes credentials and preserves mcpServers', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          github: { type: 'http', url: authFixture.url + '/mcp' },
        },
        credentials: {
          github: {
            tokens: {
              access_token: 'at-123',
              token_type: 'Bearer',
              refresh_token: 'rt-456',
            },
          },
        },
      }),
    );
    const result = runCli(['logout', 'github', '--config', configPath]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Removed credentials');

    // Verify credentials are gone but mcpServers intact
    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed.credentials?.github).toBeUndefined();
    expect(parsed.mcpServers.github).toBeDefined();
  });
});
