import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { discoverAuth } from './oauth-discovery.js';

/** Resolves once the given HTTP server has fully closed. */
function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Starts a spec-compliant server: PRM at the MCP path points to the host
 * root as the authorization server, and AS metadata is served ONLY at the
 * root (not at the /mcp path). Models GitHub/Notion's two-host layout on a
 * single port.
 */
function startPrmServer(): Promise<{ server: http.Server; mcpUrl: string }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const origin = `http://${req.headers.host}`;
    res.setHeader('Access-Control-Allow-Origin', '*');

    // RFC 9728 Protected Resource Metadata (path-aware).
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          bearer_methods_supported: ['header'],
          resource_name: 'PRM Fixture',
        }),
      );
      return;
    }

    // RFC 8414 AS metadata at the ROOT only (not at /mcp).
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end('{}');
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, mcpUrl: `http://localhost:${addr.port}/mcp` });
    });
  });
}

/**
 * Starts a legacy server: NO PRM anywhere, AS metadata at the host root
 * only, MCP endpoint on the /mcp subpath. Models older MCP servers and the
 * existing login-command test fixture.
 */
function startLegacyServer(): Promise<{ server: http.Server; mcpUrl: string }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const origin = `http://${req.headers.host}`;
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end('{}');
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, mcpUrl: `http://localhost:${addr.port}/mcp` });
    });
  });
}

/** Starts a server that serves no OAuth metadata at all. */
function startBareServer(): Promise<{ server: http.Server; mcpUrl: string }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, mcpUrl: `http://localhost:${addr.port}/mcp` });
    });
  });
}

describe('discoverAuth', () => {
  let prm: Awaited<ReturnType<typeof startPrmServer>>;
  let legacy: Awaited<ReturnType<typeof startLegacyServer>>;
  let bare: Awaited<ReturnType<typeof startBareServer>>;

  beforeAll(async () => {
    prm = await startPrmServer();
    legacy = await startLegacyServer();
    bare = await startBareServer();
  });

  afterAll(async () => {
    await Promise.all([
      closeServer(prm.server),
      closeServer(legacy.server),
      closeServer(bare.server),
    ]);
  });

  it('follows PRM authorization_servers to discover AS metadata (two-step)', async () => {
    const discovered = await discoverAuth(new URL(prm.mcpUrl));

    expect(discovered.resourceMetadata).toBeDefined();
    expect(discovered.resourceMetadata?.authorization_servers).toEqual([
      new URL(prm.mcpUrl).origin,
    ]);
    expect(discovered.serverMetadata).toBeDefined();
    // AS metadata was found at the PRM-advertised AS URL (the origin root),
    // not at the MCP /mcp path.
    expect(discovered.authorizationServerUrl.href).toBe(new URL(prm.mcpUrl).origin + '/');
    expect(discovered.serverMetadata?.authorization_endpoint).toBeTruthy();
  });

  it('falls back to origin-root AS discovery for legacy servers without PRM', async () => {
    const discovered = await discoverAuth(new URL(legacy.mcpUrl));

    // No PRM published.
    expect(discovered.resourceMetadata).toBeUndefined();
    // AS metadata still found via the origin-root fallback.
    expect(discovered.serverMetadata).toBeDefined();
    expect(discovered.authorizationServerUrl.href).toBe(new URL(legacy.mcpUrl).origin + '/');
  });

  it('returns undefined serverMetadata when no OAuth metadata is published', async () => {
    const discovered = await discoverAuth(new URL(bare.mcpUrl));

    expect(discovered.resourceMetadata).toBeUndefined();
    expect(discovered.serverMetadata).toBeUndefined();
  });
});

describe('discoverAuth — timeout on hung well-known endpoint', () => {
  // A server that accepts every request but never responds, simulating a
  // CDN/proxy that hangs the OAuth well-known probes forever. Without the
  // timeout fetch, discoverAuth would block indefinitely.
  function startHangingServer(): Promise<{ server: http.Server; mcpUrl: string }> {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Intentionally never end the response.
    });
    return new Promise((resolve) => {
      server.listen(0, () => {
        const addr = server.address() as AddressInfo;
        resolve({ server, mcpUrl: `http://localhost:${addr.port}/mcp` });
      });
    });
  }

  it('does not hang forever when well-known endpoints never respond', async () => {
    const prev = process.env.MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS;
    process.env.MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS = '150';
    const hanging = await startHangingServer();
    try {
      const start = Date.now();
      await expect(discoverAuth(new URL(hanging.mcpUrl))).rejects.toThrow();
      const elapsed = Date.now() - start;
      // Each candidate probe times out at 150ms; with up to 4 probes
      // (PRM path-aware + root, then AS at the URL + origin) the whole
      // flow must still finish in well under the 30s SDK default.
      expect(elapsed).toBeLessThan(5000);
    } finally {
      if (prev === undefined) delete process.env.MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS;
      else process.env.MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS = prev;
      // Force-close the hanging connections so the test process can exit.
      hanging.server.closeAllConnections();
      await closeServer(hanging.server);
    }
  });
});
