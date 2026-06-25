import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { handleLogin } from './login-command.js';
import { OAUTH_CALLBACK_PATH } from '../services/oauth.js';

vi.mock('../utils/open-browser.js', () => ({
  openBrowser: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Starts a minimal HTTP server that serves OAuth discovery metadata and
 * handles dynamic client registration. The authorization endpoint returns
 * a 302 redirect, but since openBrowser is mocked, the browser never opens
 * and the callback never reaches the temp server, triggering the timeout.
 */
function startDiscoveryServer(): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);

      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : '0';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: `http://localhost:${port}`,
            authorization_endpoint: `http://localhost:${port}/authorize`,
            token_endpoint: `http://localhost:${port}/token`,
            registration_endpoint: `http://localhost:${port}/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code'],
            code_challenge_methods_supported: ['S256'],
          }),
        );
        return;
      }

      if (req.method === 'POST' && url.pathname === '/register') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            client_id: 'test-client-id',
            client_secret: 'test-client-secret',
            redirect_uris: [`http://localhost:0${OAUTH_CALLBACK_PATH}`],
          }),
        );
        return;
      }

      // Authorization endpoint — redirect to callback (but browser is mocked)
      if (req.method === 'GET' && url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri') || '';
        const state = url.searchParams.get('state') || '';
        const redirectUrl = new URL(redirectUri);
        redirectUrl.searchParams.set('code', 'auth-code-timeout-test');
        if (state) {
          redirectUrl.searchParams.set('state', state);
        }
        res.writeHead(302, { Location: redirectUrl.toString() });
        res.end();
        return;
      }

      res.writeHead(404);
      res.end('{}');
    });

    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : '0';
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * Starts a server that serves AS metadata WITHOUT a registration_endpoint
 * (models a no-DCR authorization server like GitHub's). The authorize
 * endpoint redirects, but openBrowser is mocked so login reaches the
 * callback timeout — proving discovery succeeded and DCR was skipped.
 */
function startNoDcrServer(): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);

      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : '0';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // NOTE: no registration_endpoint — DCR is not supported.
        res.end(
          JSON.stringify({
            issuer: `http://localhost:${port}`,
            authorization_endpoint: `http://localhost:${port}/authorize`,
            token_endpoint: `http://localhost:${port}/token`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code'],
            code_challenge_methods_supported: ['S256'],
          }),
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri') || '';
        const state = url.searchParams.get('state') || '';
        const redirectUrl = new URL(redirectUri);
        redirectUrl.searchParams.set('code', 'auth-code-no-dcr');
        if (state) {
          redirectUrl.searchParams.set('state', state);
        }
        res.writeHead(302, { Location: redirectUrl.toString() });
        res.end();
        return;
      }

      res.writeHead(404);
      res.end('{}');
    });

    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : '0';
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('handleLogin', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-login-test-'));
    configPath = path.join(tmpDir, 'mcp.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it('throws guided error when server name not in config', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { github: { type: 'http', url: 'https://api.github.com/mcp' } },
      }),
    );
    await expect(handleLogin(configPath, 'unknown')).rejects.toThrow(
      /Server "unknown" not found.*Available servers: github/,
    );
  });

  it('throws guided error when no servers configured', async () => {
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }));
    await expect(handleLogin(configPath, 'unknown')).rejects.toThrow(
      /Server "unknown" not found.*No servers configured/,
    );
  });

  it('throws guided error for stdio servers (OAuth only for HTTP)', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { local: { type: 'stdio', command: 'node' } },
      }),
    );
    await expect(handleLogin(configPath, 'local')).rejects.toThrow(
      /OAuth is only supported for HTTP servers/,
    );
  });

  it('rejects with timeout error if callback not received within timeout', async () => {
    process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS = '500';

    const { server, url } = await startDiscoveryServer();

    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          test: { type: 'http', url: url + '/mcp' },
        },
      }),
    );

    try {
      // openBrowser is mocked, so no browser opens and the callback
      // never reaches the temp server. The short 500ms timeout fires.
      await expect(handleLogin(configPath, 'test')).rejects.toThrow(/timed out/);
    } finally {
      delete process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS;
      server.close();
    }
  }, 10_000);

  it('throws guided error when AS has no registration endpoint and no static clientId', async () => {
    const { server, url } = await startNoDcrServer();

    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          nodcr: { type: 'http', url: url + '/mcp' },
        },
      }),
    );

    try {
      await expect(handleLogin(configPath, 'nodcr')).rejects.toThrow(
        /does not support dynamic client registration.*oauth\.clientId/,
      );
    } finally {
      server.close();
    }
  });

  it('skips DCR and proceeds when a static oauth.clientId is configured', async () => {
    process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS = '500';
    const { server, url } = await startNoDcrServer();

    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          nodcr: {
            type: 'http',
            url: url + '/mcp',
            oauth: { clientId: 'pre-registered-client-id' },
          },
        },
      }),
    );

    try {
      // With a static clientId, DCR is skipped. Discovery + authorize succeed,
      // and login reaches the callback wait, which times out (openBrowser is
      // mocked). Asserting "timed out" proves the no-DCR path did NOT throw.
      await expect(handleLogin(configPath, 'nodcr')).rejects.toThrow(/timed out/);
    } finally {
      delete process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS;
      server.close();
    }
  }, 10_000);

  it('throws when --port override is out of range', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          nodcr: {
            type: 'http',
            url: 'http://127.0.0.1:1/mcp',
            oauth: { clientId: 'pre-registered-client-id' },
          },
        },
      }),
    );

    // Validation runs before any network probe, so no server is contacted.
    await expect(handleLogin(configPath, 'nodcr', 70000)).rejects.toThrow(
      /--port must be an integer/,
    );
  });
});
