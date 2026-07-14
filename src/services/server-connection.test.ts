import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ServerConnection } from './server-connection.js';
import { saveToolCache } from './tool-cache.js';
import { Logger } from '../utils/index.js';
import type { DownstreamServerConfig, ToolDescriptor } from '../utils/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, '..', '..', 'test', 'fixture-server.ts');
const tsxCommand = path.resolve('node_modules/.bin/tsx');

async function nodeExists(cmd: string): Promise<boolean> {
  try {
    await fs.access(cmd);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommand(): Promise<{ command: string; args: string[] }> {
  if (await nodeExists(tsxCommand)) {
    return { command: tsxCommand, args: [fixturePath] };
  }
  return { command: 'node', args: [fixturePath.replace('.ts', '.js')] };
}

async function makeTempConfigPath(): Promise<string> {
  const dir = path.join(tmpdir(), `mcp-conn-test-${Date.now()}-${Math.random()}`);
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, 'mcp.json');
}

const sampleCachedTools: ToolDescriptor[] = [
  { name: 'cached_tool', inputSchema: { type: 'object', properties: {} } },
];

describe('ServerConnection — connect (success)', () => {
  it('connects to a stdio fixture and discovers tools', async () => {
    const resolved = await resolveCommand();
    const config: DownstreamServerConfig = {
      name: 'fixture',
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
    };
    const configPath = await makeTempConfigPath();
    const conn = new ServerConnection(config, configPath, new Logger('error'));

    const result = await conn.connect();

    expect(result.name).toBe('fixture');
    expect(result.status).toBe('ok');
    expect(result.tools.length).toBeGreaterThan(0);
    expect(conn.status).toBe('ok');

    await conn.close();
    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  });

  it('saves tools to cache on successful connect', async () => {
    const resolved = await resolveCommand();
    const config: DownstreamServerConfig = {
      name: 'fixture',
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
    };
    const configPath = await makeTempConfigPath();
    const conn = new ServerConnection(config, configPath, new Logger('error'));

    await conn.connect();
    await conn.close();

    const cachePath = path.join(path.dirname(configPath), 'tools-cache.json');
    const raw = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
    expect(raw.fixture).toBeDefined();
    expect(raw.fixture.tools).toHaveLength(6);
    expect(raw.fixture.cachedAt).toBeDefined();

    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  });
});

describe('ServerConnection — connect (failure with warm cache)', () => {
  it('returns degraded status with cached tools when connect fails and cache exists', async () => {
    const config: DownstreamServerConfig = {
      name: 'dead',
      type: 'stdio',
      command: '/nonexistent/command',
    };
    const configPath = await makeTempConfigPath();
    await saveToolCache(configPath, 'dead', sampleCachedTools);

    const conn = new ServerConnection(config, configPath, new Logger('error'));
    const result = await conn.connect();

    expect(result.name).toBe('dead');
    expect(result.status).toBe('unavailable');
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('cached_tool');
    expect(conn.status).toBe('unavailable');
    expect(conn.lastError).toBeDefined();

    // No client should be live for a degraded connection
    await conn.close();
    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  });

  it('throws when connect fails and no cache exists (cold fail-fast)', async () => {
    const config: DownstreamServerConfig = {
      name: 'dead',
      type: 'stdio',
      command: '/nonexistent/command',
    };
    const configPath = await makeTempConfigPath();
    const conn = new ServerConnection(config, configPath, new Logger('error'));

    await expect(conn.connect()).rejects.toThrow(/dead/);
    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  });

  it('cleans up the half-initialized client when connect fails with a warm cache', async () => {
    const config: DownstreamServerConfig = {
      name: 'dead',
      type: 'stdio',
      command: '/nonexistent/command',
    };
    const configPath = await makeTempConfigPath();
    await saveToolCache(configPath, 'dead', sampleCachedTools);
    const conn = new ServerConnection(config, configPath, new Logger('error'));

    const result = await conn.connect();
    expect(result.status).toBe('unavailable');

    // A failed connect must leave no lingering client; recovery builds a
    // fresh one via reconnect(). invokeTool must report "no active client"
    // rather than calling into a half-initialized transport.
    await expect(conn.invokeTool('echo', {})).rejects.toThrow(/no active client/);

    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  });
});

describe('ServerConnection — connect (auth failure classification)', () => {
  it('classifies an invalid_token response as unauthorized (not unavailable)', async () => {
    // A downstream HTTP server that rejects every request with an OAuth
    // invalid_token error in the response body — reproducing how servers
    // like Notion surface a missing/expired access token without invoking
    // the SDK's 401 -> redirectToAuthorization flow. The SDK wraps this as
    // a transport error whose message carries the body, so isAuthError must
    // classify it as 'unauthorized' (pointing the user at `login`) rather
    // than a generic 'unavailable' connection failure.
    const authRejecting = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'invalid_token',
          error_description: 'Missing or invalid access token',
        }),
      );
    });

    const port = await new Promise<number>((resolve, reject) => {
      authRejecting.listen(0, () => {
        const addr = authRejecting.address();
        if (addr && typeof addr !== 'string') {
          resolve(addr.port);
        } else {
          reject(new Error('failed to listen'));
        }
      });
      authRejecting.on('error', reject);
    });

    const config: DownstreamServerConfig = {
      name: 'notion-like',
      type: 'http',
      url: `http://localhost:${port}/mcp`,
    };
    const configPath = await makeTempConfigPath();
    await saveToolCache(configPath, 'notion-like', sampleCachedTools);

    const conn = new ServerConnection(config, configPath, new Logger('error'));
    const result = await conn.connect();

    expect(result.status).toBe('unauthorized');
    expect(result.tools).toHaveLength(1);
    expect(conn.status).toBe('unauthorized');
    expect(conn.lastError).toContain('invalid_token');

    await conn.close();
    authRejecting.close();
    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  });
});

describe('ServerConnection — reconnect', () => {
  it('reconnects to a working stdio server', async () => {
    const resolved = await resolveCommand();
    const config: DownstreamServerConfig = {
      name: 'fixture',
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
    };
    const configPath = await makeTempConfigPath();
    const conn = new ServerConnection(config, configPath, new Logger('error'));

    await conn.connect();
    const result = await conn.reconnect();

    expect(result.status).toBe('ok');
    expect(result.tools.length).toBeGreaterThan(0);

    await conn.close();
    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  });

  it('throws when reconnect target is unreachable', async () => {
    const config: DownstreamServerConfig = {
      name: 'dead',
      type: 'stdio',
      command: '/nonexistent/command',
    };
    const configPath = await makeTempConfigPath();
    await saveToolCache(configPath, 'dead', sampleCachedTools);

    const conn = new ServerConnection(config, configPath, new Logger('error'));
    await conn.connect(); // degraded (warm cache)
    await expect(conn.reconnect()).rejects.toThrow();

    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  });

  it('deduplicates concurrent reconnect calls', async () => {
    const resolved = await resolveCommand();
    const config: DownstreamServerConfig = {
      name: 'fixture',
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
    };
    const configPath = await makeTempConfigPath();
    const conn = new ServerConnection(config, configPath, new Logger('error'));

    await conn.connect();

    const [r1, r2] = await Promise.all([conn.reconnect(), conn.reconnect()]);

    // Both should return the same result (same reference from dedup)
    expect(r1).toBe(r2);
    expect(r1.status).toBe('ok');

    await conn.close();
    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  });

  it('sets lastReconnectAt after a reconnect attempt', async () => {
    const resolved = await resolveCommand();
    const config: DownstreamServerConfig = {
      name: 'fixture',
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
    };
    const configPath = await makeTempConfigPath();
    const conn = new ServerConnection(config, configPath, new Logger('error'));

    await conn.connect();
    expect(conn.lastReconnectAt).toBe(0);

    const before = Date.now();
    await conn.reconnect();
    const after = Date.now();

    expect(conn.lastReconnectAt).toBeGreaterThanOrEqual(before);
    expect(conn.lastReconnectAt).toBeLessThanOrEqual(after);
    expect(conn.cooldownElapsed).toBe(true); // successful reconnect resets cooldown

    await conn.close();
    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  });

  it('transitions to unavailable and engages cooldown when reconnect fails', async () => {
    // A fresh connection defaults to 'ok'. A failed reconnect must transition
    // the status to 'unavailable' (was previously left as 'ok'), record the
    // error, and engage the cooldown so subsequent calls back off instead of
    // re-running the connect→fail cycle with no backoff.
    const config: DownstreamServerConfig = {
      name: 'dead',
      type: 'stdio',
      command: '/nonexistent/command',
    };
    const configPath = await makeTempConfigPath();
    const conn = new ServerConnection(config, configPath, new Logger('error'));
    expect(conn.status).toBe('ok');

    await expect(conn.reconnect()).rejects.toThrow();

    expect(conn.status).toBe('unavailable');
    expect(conn.lastError).toBeDefined();
    expect(conn.cooldownElapsed).toBe(false); // 30s cooldown engaged

    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  });

  it('awaitReconnectInFlight returns undefined when no reconnect is running', async () => {
    const resolved = await resolveCommand();
    const config: DownstreamServerConfig = {
      name: 'fixture',
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
    };
    const configPath = await makeTempConfigPath();
    const conn = new ServerConnection(config, configPath, new Logger('error'));

    expect(await conn.awaitReconnectInFlight()).toBeUndefined();

    await conn.close();
    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  });
});

describe('ServerConnection — invokeTool', () => {
  it('invokes a tool on a connected stdio server', async () => {
    const resolved = await resolveCommand();
    const config: DownstreamServerConfig = {
      name: 'fixture',
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
    };
    const configPath = await makeTempConfigPath();
    const conn = new ServerConnection(config, configPath, new Logger('error'));
    await conn.connect();

    const result = await conn.invokeTool('echo', { message: 'hello' });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]).toMatchObject({ type: 'text', text: 'hello' });

    await conn.close();
    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  });

  it('throws when no client is connected', async () => {
    const resolved = await resolveCommand();
    const config: DownstreamServerConfig = {
      name: 'fixture',
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
    };
    const configPath = await makeTempConfigPath();
    const conn = new ServerConnection(config, configPath, new Logger('error'));
    // Never called connect()

    await expect(conn.invokeTool('echo', {})).rejects.toThrow(/no active client/);

    await fs.rm(path.dirname(configPath), { recursive: true, force: true });
  });
});
