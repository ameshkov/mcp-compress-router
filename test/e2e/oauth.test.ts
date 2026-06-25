import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { routerPath, browserMockPath } from './helpers.js';
import { createAuthFixtureServer } from '../fixture-auth-server.js';
import type { AuthFixtureServer } from '../fixture-auth-server.js';
import { spawnSync, spawn } from 'node:child_process';

/**
 * Resolves a free TCP port by binding to 0 and immediately closing.
 * Supplies a concrete `--port` value the login command can actually bind.
 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.createServer();
    sock.unref();
    sock.on('error', reject);
    sock.listen(0, () => {
      const addr = sock.address();
      sock.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
    });
  });
}

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
  function runCli(
    args: string[],
    options: { extraEnv?: NodeJS.ProcessEnv; timeout?: number } = {},
  ): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync('node', [routerPath, ...args], {
      env: { ...process.env, MCP_COMPRESS_ROUTER_HOME: tempDir, ...options.extraEnv },
      timeout: options.timeout ?? 10000,
    });
    return {
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      exitCode: result.status ?? -1,
    };
  }

  // Async CLI runner. The auth fixture server runs in-process, so the
  // OAuth success flow (which makes HTTP requests back to that fixture)
  // cannot use spawnSync — it would block this worker's event loop and
  // deadlock the fixture. spawn keeps the loop free to serve requests.
  function runCliAsync(
    args: string[],
    options: { extraEnv?: NodeJS.ProcessEnv; timeout?: number } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [routerPath, ...args], {
        env: { ...process.env, MCP_COMPRESS_ROUTER_HOME: tempDir, ...options.extraEnv },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: -1 });
      }, options.timeout ?? 10000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? -1 });
      });
      child.on('error', reject);
    });
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
      }),
    );
    const credPath = path.join(tempDir, 'credentials.json');
    await fs.writeFile(
      credPath,
      JSON.stringify({
        github: {
          tokens: {
            access_token: 'at-123',
            token_type: 'Bearer',
            refresh_token: 'rt-456',
          },
        },
      }),
    );
    const result = runCli(['logout', 'github', '--config', configPath]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Removed credentials');

    // Verify credentials file is deleted when last entry removed
    await expect(fs.readFile(credPath, 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // Verify mcpServers intact in mcp.json
    const configContents = await fs.readFile(configPath, 'utf-8');
    const configParsed = JSON.parse(configContents);
    expect(configParsed.mcpServers.github).toBeDefined();
    expect(configParsed.credentials).toBeUndefined();
  });

  it('login completes the OAuth success flow and stores tokens', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          authsrv: { type: 'http', url: authFixture.url + '/mcp' },
        },
      }),
    );

    // Drive the "browser" step with a headless mock that follows the OAuth
    // authorize URL redirects, delivering the authorization code back to the
    // login command's local callback server.
    const result = await runCliAsync(['login', 'authsrv', '--config', configPath], {
      extraEnv: { MCP_COMPRESS_ROUTER_BROWSER: `node ${browserMockPath}` },
      timeout: 20000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Successfully authenticated');
    expect(result.stdout).toContain('authsrv');
    expect(result.stdout).toContain('credentials.json');

    // The full flow (discover -> register -> authorize -> exchange) must
    // have persisted real tokens in credentials.json.
    const credPath = path.join(tempDir, 'credentials.json');
    const creds = JSON.parse(await fs.readFile(credPath, 'utf-8'));
    expect(creds.authsrv).toBeDefined();
    expect(creds.authsrv.tokens.access_token).toMatch(/^at-/);
    expect(creds.authsrv.tokens.refresh_token).toMatch(/^rt-/);
    expect(creds.authsrv.tokens.token_type).toBe('Bearer');
  }, 25000);

  it('login --port binds the callback server to the exact port', async () => {
    const port = await getFreePort();
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          authsrv: { type: 'http', url: authFixture.url + '/mcp' },
        },
      }),
    );

    const result = await runCliAsync(
      ['login', 'authsrv', '--port', String(port), '--config', configPath],
      {
        extraEnv: { MCP_COMPRESS_ROUTER_BROWSER: `node ${browserMockPath}` },
        timeout: 20000,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Successfully authenticated');

    // The redirect_uri the fixture received must carry the exact fixed port.
    expect(authFixture.getLastRedirectUri()).toBe(
      `http://localhost:${port}/mcp-compress-router/oauth-callback`,
    );
  }, 25000);

  it('login uses oauth.callbackPort from config when --port is omitted', async () => {
    const port = await getFreePort();
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          authsrv: {
            type: 'http',
            url: authFixture.url + '/mcp',
            oauth: { callbackPort: port },
          },
        },
      }),
    );

    const result = await runCliAsync(['login', 'authsrv', '--config', configPath], {
      extraEnv: { MCP_COMPRESS_ROUTER_BROWSER: `node ${browserMockPath}` },
      timeout: 20000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Successfully authenticated');
    expect(authFixture.getLastRedirectUri()).toBe(
      `http://localhost:${port}/mcp-compress-router/oauth-callback`,
    );
  }, 25000);
});
