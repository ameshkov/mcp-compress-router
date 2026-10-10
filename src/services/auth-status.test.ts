import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { probeAuthRequirement, computeAuthStatus, persistAuthRequirements } from './auth-status.js';
import { createAuthFixtureServer } from '../../test/fixture-auth-server.js';
import { createHttpFixtureServer } from '../../test/fixture-http-server.js';
import { readCredentials, writeCredentials } from '../cli/config-io.js';
import { Logger, resolveServerTimeouts } from '../utils/index.js';
import type { DownstreamServerConfig, StoredCredentials } from '../utils/index.js';

/** Resolves once the given HTTP server has fully closed. */
function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** Creates a server that responds 500 to every request, used to force
 *  a probing error (the SDK only throws on 5xx, not on 4xx/network errors). */
function createErroringServer(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal' }));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://localhost:${addr.port}` });
    });
    server.on('error', reject);
  });
}

/** Creates a server that answers every request with an HTML page (e.g.
 *  an SPA catch-all route), which is NOT an OAuth metadata endpoint. */
function createHtmlServer(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body>not an MCP server</body></html>');
  });
  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://localhost:${addr.port}` });
    });
    server.on('error', reject);
  });
}

describe('probeAuthRequirement', () => {
  let authFixture: Awaited<ReturnType<typeof createAuthFixtureServer>>;
  let httpFixture: Awaited<ReturnType<typeof createHttpFixtureServer>>;
  let httpUrl: string;
  let erroring: { server: http.Server; url: string };
  let html: { server: http.Server; url: string };

  beforeAll(async () => {
    authFixture = await createAuthFixtureServer();
    httpFixture = await createHttpFixtureServer();
    const addr = httpFixture.server.address() as AddressInfo;
    httpUrl = `http://localhost:${addr.port}`;
    erroring = await createErroringServer();
    html = await createHtmlServer();
  });

  afterAll(async () => {
    await Promise.all([
      closeServer(authFixture.server),
      closeServer(httpFixture.server),
      closeServer(erroring.server),
      closeServer(html.server),
    ]);
  });

  it('returns "oauth" for a server advertising OAuth metadata', async () => {
    const server: DownstreamServerConfig = {
      name: 'auth-fixture',
      description: 'OAuth auth fixture server',
      type: 'http',
      url: authFixture.url,
      timeout: resolveServerTimeouts(),
    };
    expect(await probeAuthRequirement(server)).toBe('oauth');
  });

  it('returns "none" for a server without OAuth metadata', async () => {
    const server: DownstreamServerConfig = {
      name: 'plain-fixture',
      description: 'Plain HTTP fixture server',
      type: 'http',
      url: httpUrl,
      timeout: resolveServerTimeouts(),
    };
    expect(await probeAuthRequirement(server)).toBe('none');
  });

  it('returns "unknown" when the probe errors (server returns 5xx)', async () => {
    const server: DownstreamServerConfig = {
      name: 'erroring',
      description: 'Server that always errors',
      type: 'http',
      url: erroring.url,
      timeout: resolveServerTimeouts(),
    };
    expect(await probeAuthRequirement(server)).toBe('unknown');
  });

  it('returns "none" when the probe gets a non-JSON (HTML) response', async () => {
    // An HTML page at the well-known endpoints means the server
    // publishes no OAuth metadata — a clean miss, not a probe error.
    const server: DownstreamServerConfig = {
      name: 'html',
      description: 'Server returning HTML',
      type: 'http',
      url: html.url,
      timeout: resolveServerTimeouts(),
    };
    expect(await probeAuthRequirement(server)).toBe('none');
  });

  it('returns "none" for stdio servers without any network access', async () => {
    const server: DownstreamServerConfig = {
      name: 'local',
      description: 'Local stdio server',
      type: 'stdio',
      command: 'echo',
      timeout: resolveServerTimeouts(),
    };
    expect(await probeAuthRequirement(server)).toBe('none');
  });
});

describe('computeAuthStatus', () => {
  const httpServer: DownstreamServerConfig = {
    name: 'api',
    description: 'Example HTTP API server',
    type: 'http',
    url: 'https://example.com/mcp',
    timeout: resolveServerTimeouts(),
  };
  const stdioServer: DownstreamServerConfig = {
    name: 'fs',
    description: 'Example stdio filesystem server',
    type: 'stdio',
    command: 'npx',
    timeout: resolveServerTimeouts(),
  };

  it('returns "none" for stdio servers regardless of stored state', () => {
    expect(computeAuthStatus(stdioServer)).toBe('none');
    expect(computeAuthStatus(stdioServer, { authRequirement: 'oauth' })).toBe('none');
  });

  it('returns "header" when an Authorization header is configured', () => {
    const withHeader: DownstreamServerConfig = {
      ...httpServer,
      headers: { Authorization: 'Bearer token' },
    };
    expect(computeAuthStatus(withHeader)).toBe('header');
    // Header takes precedence even when OAuth tokens are stored.
    expect(
      computeAuthStatus(withHeader, {
        authRequirement: 'oauth',
        tokens: { access_token: 'at', token_type: 'Bearer' },
      }),
    ).toBe('header');
  });

  it('returns "authenticated" when OAuth is advertised and tokens are present', () => {
    // No serverUrl: a legacy entry is adopted rather than rejected.
    const stored: StoredCredentials = {
      authRequirement: 'oauth',
      tokens: { access_token: 'at', token_type: 'Bearer' },
    };
    expect(computeAuthStatus(httpServer, stored)).toBe('authenticated');
  });

  it('returns "requires login" when tokens are bound to a different server URL', () => {
    const stored: StoredCredentials = {
      serverUrl: 'https://old.example.com/mcp',
      authRequirement: 'oauth',
      tokens: { access_token: 'at', token_type: 'Bearer' },
    };
    expect(computeAuthStatus(httpServer, stored)).toBe('requires login');
  });

  it('returns "requires login" when OAuth is advertised but no tokens', () => {
    const stored: StoredCredentials = { authRequirement: 'oauth' };
    expect(computeAuthStatus(httpServer, stored)).toBe('requires login');
  });

  it('returns "public" when the probe found no OAuth metadata', () => {
    const stored: StoredCredentials = { authRequirement: 'none' };
    expect(computeAuthStatus(httpServer, stored)).toBe('public');
  });

  it('returns "unknown" when no credentials entry exists', () => {
    expect(computeAuthStatus(httpServer, undefined)).toBe('unknown');
  });

  it('returns "unknown" when the requirement is unknown', () => {
    const stored: StoredCredentials = { authRequirement: 'unknown' };
    expect(computeAuthStatus(httpServer, stored)).toBe('unknown');
  });
});

describe('persistAuthRequirements', () => {
  let authFixture: Awaited<ReturnType<typeof createAuthFixtureServer>>;
  let tmpDir: string;
  let configPath: string;

  beforeAll(async () => {
    authFixture = await createAuthFixtureServer();
  });

  afterAll(async () => {
    await closeServer(authFixture.server);
  });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-auth-status-test-'));
    configPath = path.join(tmpDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  /** The fixture server as a typed downstream config. */
  function fixtureServer(): DownstreamServerConfig {
    return {
      name: 'auth-fixture',
      description: 'OAuth auth fixture server',
      type: 'http',
      url: authFixture.url,
      timeout: resolveServerTimeouts(),
    };
  }

  it('records the server URL on a fresh probe entry', async () => {
    await persistAuthRequirements(configPath, [fixtureServer()], new Logger('error'));

    const store = await readCredentials(configPath);
    expect(store['auth-fixture']?.serverUrl).toBe(authFixture.url + '/');
    expect(store['auth-fixture']?.authRequirement).toBe('oauth');
  });

  it('backfills the server URL on a legacy entry and preserves credentials', async () => {
    await writeCredentials(configPath, 'auth-fixture', {
      clientRegistration: { client_id: 'legacy-client' },
      tokens: { access_token: 'at', token_type: 'Bearer' },
      authRequirement: 'oauth',
    });

    await persistAuthRequirements(configPath, [fixtureServer()], new Logger('error'));

    const store = await readCredentials(configPath);
    expect(store['auth-fixture']?.serverUrl).toBe(authFixture.url + '/');
    expect(store['auth-fixture']?.clientRegistration).toEqual({ client_id: 'legacy-client' });
    expect(store['auth-fixture']?.tokens?.access_token).toBe('at');
    expect(store['auth-fixture']?.authRequirement).toBe('oauth');
  });

  it('preserves an existing binding when the configured URL changed', async () => {
    await writeCredentials(configPath, 'auth-fixture', {
      serverUrl: 'https://old.example.com/mcp',
      tokens: { access_token: 'at', token_type: 'Bearer' },
      authRequirement: 'oauth',
    });

    await persistAuthRequirements(configPath, [fixtureServer()], new Logger('error'));

    const store = await readCredentials(configPath);
    expect(store['auth-fixture']?.serverUrl).toBe('https://old.example.com/mcp');
    expect(store['auth-fixture']?.tokens?.access_token).toBe('at');
  });

  it('re-binds a probe-only entry to the configured URL', async () => {
    // A probe-only entry carries no credentials, so its stale URL is
    // replaced instead of being preserved.
    await writeCredentials(configPath, 'auth-fixture', {
      serverUrl: 'https://old.example.com/mcp',
      authRequirement: 'none',
    });

    await persistAuthRequirements(configPath, [fixtureServer()], new Logger('error'));

    const store = await readCredentials(configPath);
    expect(store['auth-fixture']?.serverUrl).toBe(authFixture.url + '/');
  });
});
