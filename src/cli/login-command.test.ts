import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { handleLogin } from './login-command.js';
import { OAUTH_CALLBACK_PATH, OAUTH_LOOPBACK_URI } from '../services/oauth.js';
import { writeCredentials } from './config-io.js';
import { openBrowser } from '../utils/open-browser.js';

vi.mock('../utils/open-browser.js', () => ({
  openBrowser: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Starts a minimal HTTP server that serves OAuth discovery metadata and
 * handles dynamic client registration. The authorization endpoint returns
 * a 302 redirect, but since openBrowser is mocked, the browser never opens
 * and the callback never reaches the temp server, triggering the timeout.
 *
 * With `withProtectedResourceMetadata`, the server also publishes RFC 9728
 * Protected Resource Metadata pointing at its own `/mcp` endpoint, so the
 * login flow derives and sends the RFC 8707 `resource` indicator.
 */
function startDiscoveryServer(options: { withProtectedResourceMetadata?: boolean } = {}): Promise<{
  server: http.Server;
  url: string;
  registrations: Array<Record<string, unknown>>;
}> {
  return new Promise((resolve) => {
    const registrations: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);

      if (
        options.withProtectedResourceMetadata &&
        req.method === 'GET' &&
        (url.pathname === '/.well-known/oauth-protected-resource' ||
          url.pathname === '/.well-known/oauth-protected-resource/mcp')
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            resource: `http://${req.headers.host}/mcp`,
            authorization_servers: [`http://${req.headers.host}`],
            bearer_methods_supported: ['header'],
          }),
        );
        return;
      }

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
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          registrations.push(parsed);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              client_id: 'test-client-id',
              client_secret: 'test-client-secret',
              redirect_uris: parsed.redirect_uris ?? [],
            }),
          );
        });
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
      resolve({ server, url: `http://127.0.0.1:${port}`, registrations });
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

/**
 * Starts a server that serves OIDC discovery metadata advertising RFC 9207
 * `iss` support, and no RFC 8414 endpoint. The authorize endpoint redirects
 * WITHOUT `iss`, so a login that honors the advertised flag must ignore the
 * callback and time out. The SDK's OIDC discovery schema strips the flag
 * from the parsed metadata, which is why the flag must be read from the raw
 * document.
 */
function startOidcDiscoveryServer(): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);

      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : '0';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: `http://localhost:${port}`,
            authorization_endpoint: `http://localhost:${port}/authorize`,
            token_endpoint: `http://localhost:${port}/token`,
            jwks_uri: `http://localhost:${port}/jwks`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code'],
            code_challenge_methods_supported: ['S256'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            authorization_response_iss_parameter_supported: true,
          }),
        );
        return;
      }

      // Authorization endpoint — redirect to the callback WITHOUT `iss`.
      if (req.method === 'GET' && url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri') || '';
        const state = url.searchParams.get('state') || '';
        const redirectUrl = new URL(redirectUri);
        redirectUrl.searchParams.set('code', 'auth-code-oidc-iss');
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
    vi.clearAllMocks();
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
        mcpServers: {
          github: {
            type: 'http',
            url: 'https://api.github.com/mcp',
            description: 'GitHub API tools',
          },
        },
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
        mcpServers: {
          local: { type: 'stdio', command: 'node', description: 'Local stdio server' },
        },
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
          test: { type: 'http', url: url + '/mcp', description: 'Discovery test server' },
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

  it('registers the loopback callback URI without a port', async () => {
    process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS = '500';

    const { server, url, registrations } = await startDiscoveryServer();

    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          test: { type: 'http', url: url + '/mcp', description: 'Discovery test server' },
        },
      }),
    );

    try {
      // openBrowser is mocked, so the flow reaches the callback wait and
      // times out after the registration and authorization requests.
      await expect(handleLogin(configPath, 'test')).rejects.toThrow(/timed out/);
    } finally {
      delete process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS;
      server.close();
    }

    // Dynamic client registration registers the portless loopback URI:
    // RFC 8252 §8.4 excludes the port from loopback redirect matching,
    // so the registration survives the next login.
    expect(registrations).toHaveLength(1);
    const body = registrations[0]!;
    expect(body.redirect_uris).toEqual([OAUTH_LOOPBACK_URI]);

    // Native clients must declare application_type so OIDC-aware
    // registration endpoints do not default to "web".
    expect(body.application_type).toBe('native');

    // The authorization request must carry the port the callback server
    // actually bound — it differs from the registered URI only in the
    // port component — and carry a CSRF state parameter.
    const authorizationUrl = new URL(vi.mocked(openBrowser).mock.calls[0]![0]);
    const requested = new URL(authorizationUrl.searchParams.get('redirect_uri')!);
    const registered = new URL(OAUTH_LOOPBACK_URI);
    expect(requested.protocol).toBe(registered.protocol);
    expect(requested.hostname).toBe(registered.hostname);
    expect(requested.pathname).toBe(registered.pathname);
    expect(Number(requested.port)).toBeGreaterThan(0);
    expect(authorizationUrl.searchParams.get('state')).toBeTruthy();

    // The server publishes no Protected Resource Metadata, so no RFC 8707
    // resource indicator is sent (legacy-server behavior).
    expect(authorizationUrl.searchParams.get('resource')).toBeNull();
  }, 10_000);

  it('sends the RFC 8707 resource indicator from protected resource metadata', async () => {
    process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS = '500';

    const { server, url } = await startDiscoveryServer({ withProtectedResourceMetadata: true });

    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          test: { type: 'http', url: url + '/mcp', description: 'PRM test server' },
        },
      }),
    );

    try {
      // openBrowser is mocked, so the flow reaches the callback wait and
      // times out after the registration and authorization requests.
      await expect(handleLogin(configPath, 'test')).rejects.toThrow(/timed out/);
    } finally {
      delete process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS;
      server.close();
    }

    // The authorization request must carry the resource indicator the
    // server published in its Protected Resource Metadata, so a provider
    // that binds tokens to a resource accepts the login (RFC 8707).
    const authorizationUrl = new URL(vi.mocked(openBrowser).mock.calls[0]![0]);
    expect(authorizationUrl.searchParams.get('resource')).toBe(url + '/mcp');
  }, 10_000);

  it('reuses a stored registration that covers the loopback URI', async () => {
    process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS = '500';

    const { server, url, registrations } = await startDiscoveryServer();

    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          test: { type: 'http', url: url + '/mcp', description: 'Discovery test server' },
        },
      }),
    );
    // A registration from an earlier login: same scheme, host, and path
    // as OAUTH_LOOPBACK_URI, only the (ephemeral) port differs.
    await writeCredentials(configPath, 'test', {
      clientRegistration: {
        client_id: 'legacy-client',
        client_secret: 'legacy-secret',
        redirect_uris: [`http://127.0.0.1:54321${OAUTH_CALLBACK_PATH}`],
      },
    });

    try {
      await expect(handleLogin(configPath, 'test')).rejects.toThrow(/timed out/);
    } finally {
      delete process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS;
      server.close();
    }

    // The port is excluded from loopback matching, so the stored
    // registration is reused and no new client is registered.
    expect(registrations).toHaveLength(0);
  }, 10_000);

  it('re-registers when the stored registration does not cover the loopback URI', async () => {
    process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS = '500';

    const { server, url, registrations } = await startDiscoveryServer();

    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          test: { type: 'http', url: url + '/mcp', description: 'Discovery test server' },
        },
      }),
    );
    // A legacy registration for a different host: the host is compared,
    // so it cannot satisfy the loopback URI and must be replaced.
    await writeCredentials(configPath, 'test', {
      clientRegistration: {
        client_id: 'legacy-client',
        client_secret: 'legacy-secret',
        redirect_uris: [`http://localhost:54321${OAUTH_CALLBACK_PATH}`],
      },
    });

    try {
      await expect(handleLogin(configPath, 'test')).rejects.toThrow(/timed out/);
    } finally {
      delete process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS;
      server.close();
    }

    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.redirect_uris).toEqual([OAUTH_LOOPBACK_URI]);
  }, 10_000);

  it('throws the guided no-DCR error when a non-covering registration cannot be re-registered', async () => {
    const { server, url } = await startNoDcrServer();

    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          nodcr: { type: 'http', url: url + '/mcp', description: 'No-DCR test server' },
        },
      }),
    );
    await writeCredentials(configPath, 'nodcr', {
      clientRegistration: {
        client_id: 'legacy-client',
        client_secret: 'legacy-secret',
        redirect_uris: [`http://localhost:54321${OAUTH_CALLBACK_PATH}`],
      },
    });

    try {
      // The stored registration cannot be reused (different host) and
      // the server advertises no registration endpoint, so login must
      // fail with the existing guided error instead of attempting a
      // doomed authorization request.
      await expect(handleLogin(configPath, 'nodcr')).rejects.toThrow(
        /does not support dynamic client registration.*oauth\.clientId/,
      );
    } finally {
      server.close();
    }
  });

  it('honors the RFC 9207 iss flag read from OIDC discovery metadata', async () => {
    process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS = '500';

    const { server, url } = await startOidcDiscoveryServer();

    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          oidc: {
            type: 'http',
            url: url + '/mcp',
            description: 'OIDC discovery test server',
            oauth: { clientId: 'pre-registered-client-id' },
          },
        },
      }),
    );

    // Follow the authorization redirect so the callback server receives a
    // response without `iss`. The advertised flag must make the login
    // ignore it and time out; if the flag were lost (the SDK's OIDC schema
    // strips it), the callback would be accepted and the flow would fail
    // later at the missing token endpoint instead.
    let callbackStatus: number | undefined;
    vi.mocked(openBrowser).mockImplementationOnce(async (authorizationUrl) => {
      const response = await fetch(authorizationUrl);
      callbackStatus = response.status;
    });

    try {
      await expect(handleLogin(configPath, 'oidc')).rejects.toThrow(/timed out/);
    } finally {
      delete process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS;
      server.close();
    }

    expect(callbackStatus).toBe(400);
  }, 10_000);

  it('throws guided error when AS has no registration endpoint and no static clientId', async () => {
    const { server, url } = await startNoDcrServer();

    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          nodcr: { type: 'http', url: url + '/mcp', description: 'No-DCR test server' },
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
            description: 'No-DCR test server',
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
            description: 'No-DCR test server',
            oauth: { clientId: 'pre-registered-client-id' },
          },
        },
      }),
    );

    // Validation runs before any network probe, so no server is contacted.
    await expect(handleLogin(configPath, 'nodcr', { portOverride: 70000 })).rejects.toThrow(
      /--port must be an integer/,
    );
  });
});
