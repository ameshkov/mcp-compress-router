import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface AuthFixtureServer {
  server: http.Server;
  url: string;
  /** Get the last authorization code issued. */
  getLastCode: () => string | undefined;
  /** Get the last refresh token issued. */
  getLastRefreshToken: () => string | undefined;
  /** Mark all refresh tokens as expired/unusable. */
  invalidateRefreshToken: () => void;
}

/**
 * Creates a minimal OAuth authorization server that protects an MCP server.
 *
 * Endpoints:
 * - GET /.well-known/oauth-authorization-server — metadata
 * - POST /register — dynamic client registration
 * - GET /authorize — authorization endpoint (auto-approves, redirects with code)
 * - POST /token — token endpoint (code exchange, refresh)
 * - POST /revoke — token revocation
 */
export async function createAuthFixtureServer(): Promise<AuthFixtureServer> {
  let lastCode: string | undefined;
  let lastRefreshToken: string | undefined;
  let refreshTokensValid = true;

  // In-memory store: client_id -> client_secret
  const registeredClients = new Map<string, string>();
  // In-memory store: access_token -> { refresh_token, expires_at }
  const issuedTokens = new Map<string, { refreshToken: string; expiresAt: number }>();

  // Create the protected MCP server
  const mcp = new McpServer({
    name: 'test-fixture-auth',
    version: '1.0.0',
  });

  mcp.registerTool(
    'echo',
    {
      title: 'Echo Tool',
      description: 'Returns the input message unchanged.',
      inputSchema: {
        message: z.string().describe('The message to echo.'),
      },
    },
    async (params) => {
      return {
        content: [{ type: 'text' as const, text: params.message }],
      };
    },
  );

  mcp.registerTool(
    'add',
    {
      title: 'Add Tool',
      description: 'Adds two numbers together.',
      inputSchema: {
        a: z.number().describe('The first number.'),
        b: z.number().describe('The second number.'),
      },
    },
    async (params) => {
      const result = params.a + params.b;
      return {
        content: [{ type: 'text' as const, text: String(result) }],
      };
    },
  );

  const authTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  let port = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Set CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // OAuth authorization server metadata
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      const baseUrl = `http://localhost:${port}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          registration_endpoint: `${baseUrl}/register`,
          revocation_endpoint: `${baseUrl}/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
      return;
    }

    // Dynamic client registration
    if (req.method === 'POST' && url.pathname === '/register') {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      const clientId = `client-${randomBytes(4).toString('hex')}`;
      const clientSecret = `secret-${randomBytes(8).toString('hex')}`;
      registeredClients.set(clientId, clientSecret);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uris: parsed.redirect_uris || ['http://localhost:0/callback'],
        }),
      );
      return;
    }

    // Authorization endpoint — auto-approve and redirect
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      const code = `auth-code-${randomBytes(8).toString('hex')}`;
      lastCode = code;

      const redirectUrl = new URL(redirectUri!);
      redirectUrl.searchParams.set('code', code);
      if (state) {
        redirectUrl.searchParams.set('state', state);
      }
      res.writeHead(302, { Location: redirectUrl.toString() });
      res.end();
      return;
    }

    // Token endpoint — code exchange and refresh
    if (req.method === 'POST' && url.pathname === '/token') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const grantType = params.get('grant_type');

      if (grantType === 'authorization_code') {
        // Exchange code for tokens
        const code = params.get('code');
        if (code === lastCode || (code && code.startsWith('auth-code-'))) {
          const accessToken = `at-${randomBytes(8).toString('hex')}`;
          const refreshToken = `rt-${randomBytes(8).toString('hex')}`;
          lastRefreshToken = refreshToken;
          issuedTokens.set(accessToken, {
            refreshToken,
            expiresAt: Date.now() + 3600 * 1000,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: accessToken,
              token_type: 'Bearer',
              refresh_token: refreshToken,
              expires_in: 3600,
              scope: 'read write',
            }),
          );
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid code' }));
        }
        return;
      }

      if (grantType === 'refresh_token') {
        const refreshToken = params.get('refresh_token');
        if (!refreshTokensValid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: 'Refresh token expired or revoked',
            }),
          );
          return;
        }
        const accessToken = `at-${randomBytes(8).toString('hex')}`;
        const newRefreshToken = `rt-${randomBytes(8).toString('hex')}`;
        lastRefreshToken = newRefreshToken;
        issuedTokens.set(accessToken, {
          refreshToken: newRefreshToken,
          expiresAt: Date.now() + 3600 * 1000,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: accessToken,
            token_type: 'Bearer',
            refresh_token: newRefreshToken,
            expires_in: 3600,
            scope: 'read write',
          }),
        );
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      return;
    }

    // Token revocation endpoint
    if (req.method === 'POST' && url.pathname === '/revoke') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Protected MCP endpoint — check Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const token = authHeader.slice(7);
    if (!issuedTokens.has(token)) {
      // Check for expired token test path
      if (token === 'expired-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized', error_description: 'Token expired' }));
        return;
      }
    }

    // Delegate to MCP transport — collect body and pass parsed JSON
    let body: string | undefined;
    if (req.method === 'POST') {
      body = await readBody(req);
    }
    await authTransport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });

  await mcp.connect(authTransport);

  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      port = addr.port;
      resolve({
        server,
        url: `http://localhost:${addr.port}`,
        getLastCode: () => lastCode,
        getLastRefreshToken: () => lastRefreshToken,
        invalidateRefreshToken: () => {
          refreshTokensValid = false;
        },
      });
    });
    server.on('error', reject);
  });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
