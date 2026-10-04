import * as http from 'node:http';

/**
 * Starts a minimal HTTP server that serves OAuth discovery metadata and
 * handles dynamic client registration. The authorization endpoint returns
 * a 302 redirect, but tests mock the browser, so the browser never opens
 * and the callback never reaches the temp server, triggering the timeout.
 *
 * With `withProtectedResourceMetadata`, the server also publishes RFC 9728
 * Protected Resource Metadata pointing at its own `/mcp` endpoint, so the
 * login flow derives and sends the RFC 8707 `resource` indicator.
 *
 * Shared by the `login` command tests; the registration bodies captured
 * here are the evidence for the DCR client-identity overrides.
 *
 * @param options - Fixture behavior flags.
 * @returns The running server, its base URL, and every registration body.
 */
export function startDiscoveryServer(
  options: { withProtectedResourceMetadata?: boolean } = {},
): Promise<{
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
