import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import * as http from 'node:http';
import { probeAuthRequirement, computeAuthStatus } from './auth-status.js';
import { createAuthFixtureServer } from '../../test/fixture-auth-server.js';
import { createHttpFixtureServer } from '../../test/fixture-http-server.js';
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

describe('probeAuthRequirement', () => {
  let authFixture: Awaited<ReturnType<typeof createAuthFixtureServer>>;
  let httpFixture: Awaited<ReturnType<typeof createHttpFixtureServer>>;
  let httpUrl: string;
  let erroring: { server: http.Server; url: string };

  beforeAll(async () => {
    authFixture = await createAuthFixtureServer();
    httpFixture = await createHttpFixtureServer();
    const addr = httpFixture.server.address() as AddressInfo;
    httpUrl = `http://localhost:${addr.port}`;
    erroring = await createErroringServer();
  });

  afterAll(async () => {
    await Promise.all([
      closeServer(authFixture.server),
      closeServer(httpFixture.server),
      closeServer(erroring.server),
    ]);
  });

  it('returns "oauth" for a server advertising OAuth metadata', async () => {
    const server: DownstreamServerConfig = {
      name: 'auth-fixture',
      type: 'http',
      url: authFixture.url,
    };
    expect(await probeAuthRequirement(server)).toBe('oauth');
  });

  it('returns "none" for a server without OAuth metadata', async () => {
    const server: DownstreamServerConfig = {
      name: 'plain-fixture',
      type: 'http',
      url: httpUrl,
    };
    expect(await probeAuthRequirement(server)).toBe('none');
  });

  it('returns "unknown" when the probe errors (server returns 5xx)', async () => {
    const server: DownstreamServerConfig = {
      name: 'erroring',
      type: 'http',
      url: erroring.url,
    };
    expect(await probeAuthRequirement(server)).toBe('unknown');
  });

  it('returns "none" for stdio servers without any network access', async () => {
    const server: DownstreamServerConfig = {
      name: 'local',
      type: 'stdio',
      command: 'echo',
    };
    expect(await probeAuthRequirement(server)).toBe('none');
  });
});

describe('computeAuthStatus', () => {
  const httpServer: DownstreamServerConfig = {
    name: 'api',
    type: 'http',
    url: 'https://example.com/mcp',
  };
  const stdioServer: DownstreamServerConfig = {
    name: 'fs',
    type: 'stdio',
    command: 'npx',
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
    const stored: StoredCredentials = {
      authRequirement: 'oauth',
      tokens: { access_token: 'at', token_type: 'Bearer' },
    };
    expect(computeAuthStatus(httpServer, stored)).toBe('authenticated');
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
