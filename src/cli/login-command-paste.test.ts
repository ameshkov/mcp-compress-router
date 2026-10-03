import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { handleLogin } from './login-command.js';
import { openBrowser } from '../utils/open-browser.js';

const { createPasteReaderMock } = vi.hoisted(() => ({
  createPasteReaderMock: vi.fn(),
}));

vi.mock('./login-paste.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./login-paste.js')>();
  return { ...actual, createPasteReader: createPasteReaderMock };
});

vi.mock('../utils/open-browser.js', () => ({
  openBrowser: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Starts a minimal OAuth authorization server: AS metadata, dynamic
 * client registration, an authorize endpoint that redirects with a code
 * and the echoed state, and a token endpoint.
 */
function startAuthServer(): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : '0';

      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
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
        res.end(JSON.stringify({ client_id: 'paste-client', redirect_uris: [] }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri') || '';
        const state = url.searchParams.get('state') || '';
        const redirect = new URL(redirectUri);
        redirect.searchParams.set('code', 'redirect-code');
        if (state) {
          redirect.searchParams.set('state', state);
        }
        res.writeHead(302, { Location: redirect.toString() });
        res.end();
        return;
      }

      if (req.method === 'POST' && url.pathname === '/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'refresh-token',
          }),
        );
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

describe('handleLogin --no-browser', () => {
  let tmpDir: string;
  let configPath: string;
  const originalTimeout = process.env.MCP_COMPRESS_ROUTER_DOWNSTREAM_TIMEOUT_MS;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.MCP_COMPRESS_ROUTER_DOWNSTREAM_TIMEOUT_MS = '500';
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-login-paste-'));
    configPath = path.join(tmpDir, 'mcp.json');
  });

  afterEach(async () => {
    if (originalTimeout === undefined) {
      delete process.env.MCP_COMPRESS_ROUTER_DOWNSTREAM_TIMEOUT_MS;
    } else {
      process.env.MCP_COMPRESS_ROUTER_DOWNSTREAM_TIMEOUT_MS = originalTimeout;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Writes a one-server config pointing at the fixture. */
  async function writeConfig(url: string): Promise<void> {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          test: { type: 'http', url: url + '/mcp', description: 'Paste test server' },
        },
      }),
    );
  }

  it('completes login with a pasted authorization code', async () => {
    const { server, url } = await startAuthServer();
    const close = vi.fn();
    createPasteReaderMock.mockReturnValue({ readLine: async () => 'pasted-code', close });
    await writeConfig(url);

    try {
      const result = await handleLogin(configPath, 'test', { noBrowser: true });
      expect(result).toContain('Successfully authenticated server "test"');
    } finally {
      server.close();
    }

    expect(openBrowser).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    const stored = JSON.parse(await fs.readFile(path.join(tmpDir, 'credentials.json'), 'utf-8'));
    expect(stored.test.tokens.access_token).toBe('access-token');
  }, 10_000);

  it('accepts a pasted redirect URL after validating its state', async () => {
    const { server, url } = await startAuthServer();
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      });
    createPasteReaderMock.mockReturnValue({
      readLine: async () => {
        // The authorization URL is printed before the prompt; fetch it
        // without following the redirect to get the exact redirect URL a
        // user would copy from their browser.
        const authorizeUrl = writes.join('').match(/https?:\/\/\S*\/authorize\S*/)?.[0];
        const response = await fetch(authorizeUrl!, { redirect: 'manual' });
        return response.headers.get('location')!;
      },
      close: vi.fn(),
    });
    await writeConfig(url);

    try {
      const result = await handleLogin(configPath, 'test', { noBrowser: true });
      expect(result).toContain('Successfully authenticated server "test"');
    } finally {
      writeSpy.mockRestore();
      server.close();
    }

    const stored = JSON.parse(await fs.readFile(path.join(tmpDir, 'credentials.json'), 'utf-8'));
    expect(stored.test.tokens.access_token).toBe('access-token');
  }, 10_000);
});
