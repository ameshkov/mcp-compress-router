import { ensureConfigDir, readConfigFile } from './config-io.js';
import { loadConfig } from '../services/config.js';

/**
 * Handles the `login <name>` subcommand.
 *
 * Validates the server exists in config and is an HTTP type.
 * For HTTP servers, runs the OAuth authorization-code flow
 * using the SDK's OAuth client infrastructure. The flow opens
 * a browser, handles the redirect callback, exchanges the
 * authorization code for tokens, and persists them in credentials.json.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name to authenticate.
 * @returns Human-readable confirmation message.
 * @throws If the server name is not found or is not an HTTP type.
 */
export async function handleLogin(configPath: string, name: string): Promise<string> {
  await ensureConfigDir(configPath);
  const servers = await readConfigFile(configPath);

  if (!(name in servers)) {
    const available = Object.keys(servers);
    const hint =
      available.length > 0
        ? ` Available servers: ${available.join(', ')}`
        : ' No servers configured.';
    throw new Error(`Server "${name}" not found.${hint}`);
  }

  const entry = servers[name];

  if (entry.type !== 'http' && entry.type !== 'streamable-http') {
    throw new Error(
      `Server "${name}" is type "${entry.type}". OAuth is only supported for HTTP servers.`,
    );
  }

  // Load the full typed config to get oauth block
  const allConfigs = await loadConfig(configPath);
  const targetServer = allConfigs.find((s) => s.name === name);
  if (!targetServer) {
    throw new Error(`Server "${name}" not found in configuration.`);
  }

  const { OAuthCredentialManager } = await import('../services/oauth.js');

  const mgr = new OAuthCredentialManager(configPath, targetServer);

  // Use the SDK's functional OAuth API
  const { discoverOAuthMetadata, registerClient, startAuthorization, exchangeAuthorization } =
    await import('@modelcontextprotocol/sdk/client/auth.js');

  // Step 1: Discover authorization server metadata
  const serverUrl = new URL(targetServer.url!);
  const metadata = await discoverOAuthMetadata(serverUrl);
  if (!metadata) {
    throw new Error(`Server "${name}" does not expose OAuth metadata.`);
  }
  if (!metadata.registration_endpoint) {
    throw new Error(`Server "${name}" does not support dynamic client registration.`);
  }

  // Step 2: Register client if dynamic and not already registered
  if (!mgr.hasStaticClient() && !(await mgr.clientInformation())) {
    const regResult = await registerClient(new URL(metadata.registration_endpoint!), {
      metadata,
      clientMetadata: mgr.clientMetadata,
    });
    await mgr.saveClientInformation(regResult);
  }

  // Step 3: Start temp server, get real port, then authorize
  const { openBrowser } = await import('../utils/open-browser.js');

  const TIMEOUT_MS = (() => {
    const env = process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS;
    if (env) {
      const parsed = parseInt(env, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return 120_000;
  })();

  const http = await import('node:http');
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  // result from startAuthorization, set inside the listen callback
  let authResult!: Awaited<ReturnType<typeof startAuthorization>>;

  const authorizationCode = await new Promise<string>((resolve, reject) => {
    const tempServer = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (code) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h1>Authorization successful!</h1><p>You can close this window.</p></body></html>',
        );
        tempServer.close();
        resolve(code);
      } else if (error) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Authorization failed</h1><p>${error}</p></body></html>`);
        tempServer.close();
        reject(new Error(`Authorization failed: ${error}`));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    tempServer.listen(0, async () => {
      try {
        const address = tempServer.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to get server address'));
          return;
        }
        const actualPort = address.port;

        // Tell the OAuth manager the real port
        mgr.setActualPort(actualPort);

        // Build authorization URL with the real redirect URL
        authResult = await startAuthorization(new URL(metadata.authorization_endpoint!), {
          metadata,
          clientInformation: (await mgr.clientInformation())!,
          redirectUrl: mgr.redirectUrl as string,
          scope: targetServer.oauth?.scope,
        });

        // Save the PKCE code verifier that startAuthorization generated
        await mgr.saveCodeVerifier(authResult.codeVerifier);

        // Open the browser
        void openBrowser(authResult.authorizationUrl.toString());

        timeoutHandle = setTimeout(() => {
          tempServer.close();
          reject(
            new Error(
              `OAuth login timed out after ${TIMEOUT_MS / 1000} seconds. Please try again.`,
            ),
          );
        }, TIMEOUT_MS);
      } catch (err) {
        reject(err);
      }
    });

    tempServer.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    });
  });

  if (timeoutHandle) clearTimeout(timeoutHandle);

  // Step 4: Exchange authorization code for tokens
  const realRedirectUrl = mgr.redirectUrl as string;
  const tokens = await exchangeAuthorization(new URL(metadata.token_endpoint!), {
    metadata,
    clientInformation: (await mgr.clientInformation())!,
    authorizationCode,
    codeVerifier: authResult.codeVerifier,
    redirectUri: realRedirectUrl,
  });

  // Step 5: Persist tokens
  await mgr.saveTokens(tokens);

  return `Successfully authenticated server "${name}". Tokens stored in credentials.json.`;
}
