/**
 * Mock OAuth 2.1 authorization server for the QA streamable-http mock.
 *
 * The mock implements just enough of RFC 9728 (Protected Resource
 * Metadata), RFC 8414 (Authorization Server Metadata), RFC 7591
 * (Dynamic Client Registration), and the authorization-code + PKCE flow
 * for the router's `login` command to work headlessly. The authorization
 * endpoint auto-approves and redirects straight back to the caller's
 * loopback callback, so the QA workspace only needs a tiny curl-based
 * "browser" (`qa-browser`) instead of a real one.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Registered client and issued-token state of the mock AS. */
export interface OAuthMockState {
  /** Issuer URL advertised in the metadata documents. */
  issuer: string;
  /** Dynamically registered clients by client id. */
  clients: Map<string, { clientSecret: string; redirectUris: string[] }>;
  /** Issued authorization codes by code. */
  codes: Map<string, { clientId: string; redirectUri: string }>;
  /** Valid access tokens. */
  accessTokens: Set<string>;
  /** Valid refresh tokens. */
  refreshTokens: Set<string>;
}

/**
 * Creates the mock authorization server state.
 *
 * @param issuer - The issuer URL to advertise.
 * @returns Fresh, empty state.
 */
export function createOAuthState(issuer: string): OAuthMockState {
  return {
    issuer,
    clients: new Map(),
    codes: new Map(),
    accessTokens: new Set(),
    refreshTokens: new Set(),
  };
}

/**
 * Generates one opaque mock token.
 *
 * @param prefix - A readable prefix (`client`, `code`, `at`, `rt`).
 * @returns The token string.
 */
function randomToken(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString('hex')}`;
}

/**
 * Writes one JSON response.
 *
 * @param res - The server response.
 * @param status - The HTTP status code.
 * @param body - The JSON body.
 * @param headers - Additional response headers.
 */
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Builds the RFC 9728 protected resource metadata document.
 *
 * @param state - The mock AS state.
 * @returns The metadata document.
 */
function protectedResourceMetadata(state: OAuthMockState): Record<string, unknown> {
  return {
    resource: `${state.issuer}/mcp`,
    authorization_servers: [state.issuer],
    bearer_methods_supported: ['header'],
    resource_name: 'QA OAuth mock MCP server',
  };
}

/**
 * Builds the RFC 8414 authorization server metadata document.
 *
 * @param state - The mock AS state.
 * @returns The metadata document.
 */
function authorizationServerMetadata(state: OAuthMockState): Record<string, unknown> {
  return {
    issuer: state.issuer,
    authorization_endpoint: `${state.issuer}/authorize`,
    token_endpoint: `${state.issuer}/token`,
    registration_endpoint: `${state.issuer}/register`,
    revocation_endpoint: `${state.issuer}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
  };
}

/**
 * Handles dynamic client registration.
 *
 * @param res - The server response.
 * @param body - The raw JSON request body.
 * @param state - The mock AS state.
 */
function handleRegister(res: ServerResponse, body: string, state: OAuthMockState): void {
  let redirectUris: string[] = [];
  try {
    const parsed = JSON.parse(body) as { redirect_uris?: string[] };
    redirectUris = parsed.redirect_uris ?? [];
  } catch {
    redirectUris = [];
  }
  const clientId = randomToken('client');
  const clientSecret = randomToken('secret');
  state.clients.set(clientId, { clientSecret, redirectUris });
  console.log(`[mock-mcp-http-oauth] registered client ${clientId}`);
  sendJson(res, 201, {
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'client_secret_post',
  });
}

/**
 * Handles the authorization endpoint (auto-approves and redirects).
 *
 * @param url - The parsed request URL.
 * @param res - The server response.
 * @param state - The mock AS state.
 */
function handleAuthorize(url: URL, res: ServerResponse, state: OAuthMockState): void {
  const redirectUri = url.searchParams.get('redirect_uri');
  if (redirectUri === null) {
    sendJson(res, 400, { error: 'invalid_request', error_description: 'missing redirect_uri' });
    return;
  }
  const code = randomToken('code');
  state.codes.set(code, {
    clientId: url.searchParams.get('client_id') ?? '',
    redirectUri,
  });
  const location = new URL(redirectUri);
  location.searchParams.set('code', code);
  const stateParam = url.searchParams.get('state');
  if (stateParam !== null) {
    location.searchParams.set('state', stateParam);
  }
  console.log(`[mock-mcp-http-oauth] auto-approved, redirecting to ${redirectUri}`);
  res.writeHead(302, { location: location.toString() });
  res.end();
}

/**
 * Handles the token endpoint for code exchange and refresh.
 *
 * @param res - The server response.
 * @param body - The raw form-encoded request body.
 * @param state - The mock AS state.
 */
function handleToken(res: ServerResponse, body: string, state: OAuthMockState): void {
  const params = new URLSearchParams(body);
  const grantType = params.get('grant_type');
  if (grantType === 'authorization_code') {
    const code = params.get('code');
    if (code === null || !state.codes.has(code)) {
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'unknown code' });
      return;
    }
    state.codes.delete(code);
  } else if (grantType === 'refresh_token') {
    const refreshToken = params.get('refresh_token');
    if (refreshToken === null || !state.refreshTokens.has(refreshToken)) {
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'unknown refresh token' });
      return;
    }
    state.refreshTokens.delete(refreshToken);
  } else {
    sendJson(res, 400, { error: 'unsupported_grant_type' });
    return;
  }
  const accessToken = randomToken('at');
  const refreshToken = randomToken('rt');
  state.accessTokens.add(accessToken);
  state.refreshTokens.add(refreshToken);
  console.log(`[mock-mcp-http-oauth] issued tokens (${grantType})`);
  sendJson(res, 200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: 'read write',
  });
}

/**
 * Checks whether a request carries a valid bearer token.
 *
 * @param state - The mock AS state.
 * @param header - The raw `Authorization` header value.
 * @returns True when the token was issued by this mock.
 */
export function isAuthorized(state: OAuthMockState, header: string | undefined): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) {
    return false;
  }
  return state.accessTokens.has(header.slice('Bearer '.length));
}

/**
 * Serves the OAuth endpoints, when the request targets one.
 *
 * @param req - The incoming request.
 * @param res - The server response.
 * @param url - The parsed request URL.
 * @param body - The raw request body (empty for GET).
 * @param state - The mock AS state.
 * @returns True when the request was handled.
 */
export async function handleOAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: string,
  state: OAuthMockState,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const prmPaths = [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ];
  if (method === 'GET' && prmPaths.includes(url.pathname)) {
    sendJson(res, 200, protectedResourceMetadata(state));
    return true;
  }
  const asPaths = ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'];
  if (method === 'GET' && asPaths.includes(url.pathname)) {
    sendJson(res, 200, authorizationServerMetadata(state));
    return true;
  }
  if (method === 'POST' && url.pathname === '/register') {
    handleRegister(res, body, state);
    return true;
  }
  if (method === 'GET' && url.pathname === '/authorize') {
    handleAuthorize(url, res, state);
    return true;
  }
  if (method === 'POST' && url.pathname === '/token') {
    handleToken(res, body, state);
    return true;
  }
  if (method === 'POST' && url.pathname === '/revoke') {
    sendJson(res, 200, {});
    return true;
  }
  return false;
}
