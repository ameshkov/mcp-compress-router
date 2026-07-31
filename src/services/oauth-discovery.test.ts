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

/**
 * Starts a server that answers every request with an HTML page (an SPA
 * catch-all route or a plain web page). The well-known endpoints are not
 * OAuth metadata endpoints, so discovery must treat this as a clean
 * "no OAuth published" rather than a probe error.
 */
function startHtmlServer(): Promise<{ server: http.Server; mcpUrl: string }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body>not an MCP server</body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, mcpUrl: `http://localhost:${addr.port}/mcp` });
    });
  });
}

/**
 * Starts a server where every authorization-server metadata probe under
 * the `/hang` subpath never responds, while PRM probes 404 immediately
 * and the origin root serves AS metadata instantly. Verifies that the
 * server-URL and origin-root candidates are probed in parallel: the hung
 * candidate must not delay discovery via the healthy origin root.
 */
function startParallelProbeServer(): Promise<{ server: http.Server; mcpUrl: string }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // PRM probes must answer immediately so discovery reaches the AS
    // candidates (the hang belongs to the AS probes of the /hang path).
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      res.writeHead(404);
      res.end('{}');
      return;
    }

    // Every AS metadata probe under the /hang subpath hangs forever.
    if (url.pathname.includes('/hang')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Intentionally never end the response.
      return;
    }

    // RFC 8414 AS metadata at the origin root.
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      const origin = `http://${req.headers.host}`;
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
      resolve({ server, mcpUrl: `http://localhost:${addr.port}/hang` });
    });
  });
}

describe('discoverAuth', () => {
  let prm: Awaited<ReturnType<typeof startPrmServer>>;
  let legacy: Awaited<ReturnType<typeof startLegacyServer>>;
  let bare: Awaited<ReturnType<typeof startBareServer>>;
  let html: Awaited<ReturnType<typeof startHtmlServer>>;
  let parallelProbe: Awaited<ReturnType<typeof startParallelProbeServer>>;

  beforeAll(async () => {
    prm = await startPrmServer();
    legacy = await startLegacyServer();
    bare = await startBareServer();
    html = await startHtmlServer();
    parallelProbe = await startParallelProbeServer();
  });

  afterAll(async () => {
    await Promise.all([
      closeServer(prm.server),
      closeServer(legacy.server),
      closeServer(bare.server),
      closeServer(html.server),
      closeServer(parallelProbe.server),
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

  it('treats a non-JSON (HTML) response as "no OAuth published" instead of an error', async () => {
    // A server that answers every well-known endpoint with an HTML page
    // is not an OAuth server. This must be a clean miss (no throw, no
    // probe failure recorded), not an "Unexpected token" error.
    const discovered = await discoverAuth(new URL(html.mcpUrl));

    expect(discovered.resourceMetadata).toBeUndefined();
    expect(discovered.serverMetadata).toBeUndefined();
  });

  it('probes fallback candidates in parallel so a hung candidate does not delay discovery', async () => {
    const prev = process.env.MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS;
    // Keep the per-fetch budget far above the test's time budget so the
    // hung /hang candidate would block sequential discovery for minutes.
    process.env.MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS = '60000';
    try {
      const start = Date.now();
      const discovered = await discoverAuth(new URL(parallelProbe.mcpUrl));

      // The server-URL candidate (/hang) hangs; only the parallel
      // origin-root candidate can answer, and it does so instantly.
      expect(discovered.serverMetadata).toBeDefined();
      expect(Date.now() - start).toBeLessThan(3000);
    } finally {
      if (prev === undefined) delete process.env.MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS;
      else process.env.MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS = prev;
      // Force-close the hung /hang connections so the test process can
      // exit (the pending fetches reject inside safeDiscoverAs).
      parallelProbe.server.closeAllConnections();
    }
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
      // Each candidate probe times out at 150ms: the PRM probe, then the
      // server-URL and origin-root AS candidates in parallel. The whole
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
