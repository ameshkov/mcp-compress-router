import type { ServerResponse } from 'node:http';
import type { OAuthMockState } from './oauth.js';
import { randomToken, sendJson } from './oauth-utils.js';

/**
 * The validated grant of one token request.
 */
interface TokenGrant {
  /** The OAuth grant type. */
  grantType: string;
  /** The RFC 8707 resource indicator the request carried. */
  resource: string;
  /** The client that made the request. */
  clientId: string;
}

/**
 * The token request fields shared by the grant checks.
 */
interface TokenRequestFields {
  /** The OAuth grant type. */
  grantType: string | null;
  /** The RFC 8707 resource indicator the request carried. */
  resource: string;
  /** The client that made the request. */
  clientId: string;
}

/**
 * Rejects a revoked client and a request without the RFC 8707 `resource`
 * parameter, like a strict provider.
 *
 * @param params - The decoded token request parameters.
 * @param res - The server response.
 * @param state - The mock AS state.
 * @returns The validated request fields, or undefined when an error response was sent.
 */
function validateTokenRequest(
  params: URLSearchParams,
  res: ServerResponse,
  state: OAuthMockState,
): TokenRequestFields | undefined {
  const clientId = params.get('client_id') ?? '';
  if (state.revokedClients.has(clientId)) {
    console.log(`[mock-mcp-http-oauth] rejected revoked client ${clientId} at /token`);
    sendJson(res, 400, { error: 'invalid_client', error_description: 'Invalid client_id' });
    return undefined;
  }
  const resource = params.get('resource');
  if (resource === null) {
    console.log('[mock-mcp-http-oauth] rejected token request without resource (RFC 8707)');
    sendJson(res, 400, {
      error: 'invalid_target',
      error_description: 'The resource (RFC 8707) parameter is required',
    });
    return undefined;
  }
  return { grantType: params.get('grant_type'), resource, clientId };
}

/**
 * Validates and consumes an authorization-code grant for the requesting
 * client (RFC 6749 §4.1.3). A code presented by another client is
 * rejected without being consumed, so its rightful client can still
 * redeem it.
 *
 * @param params - The decoded token request parameters.
 * @param res - The server response.
 * @param state - The mock AS state.
 * @param resource - The RFC 8707 resource indicator the request carried.
 * @param clientId - The client that made the request.
 * @returns The validated grant, or undefined when an error response was sent.
 */
function validateAuthorizationCodeGrant(
  params: URLSearchParams,
  res: ServerResponse,
  state: OAuthMockState,
  resource: string,
  clientId: string,
): TokenGrant | undefined {
  const code = params.get('code');
  const grant = code === null ? undefined : state.codes.get(code);
  if (code === null || grant === undefined) {
    sendJson(res, 400, { error: 'invalid_grant', error_description: 'unknown code' });
    return undefined;
  }
  // RFC 6749 §4.1.3: the authorization server must ensure the code
  // was issued to the client making the request. A mismatch does not
  // consume the code: the rightful client can still redeem it.
  if (grant.clientId !== clientId) {
    console.log(
      `[mock-mcp-http-oauth] rejected authorization code issued to another client ${clientId}`,
    );
    sendJson(res, 400, {
      error: 'invalid_grant',
      error_description: 'authorization code issued to another client',
    });
    return undefined;
  }
  state.codes.delete(code);
  return { grantType: 'authorization_code', resource, clientId: grant.clientId };
}

/**
 * Validates and consumes a refresh-token grant for the client the token
 * was issued to (RFC 6749 §6). A token presented by another client is
 * rejected without being consumed, so its rightful client can still use
 * it.
 *
 * @param params - The decoded token request parameters.
 * @param res - The server response.
 * @param state - The mock AS state.
 * @param resource - The RFC 8707 resource indicator the request carried.
 * @param clientId - The client that made the request.
 * @returns The validated grant, or undefined when an error response was sent.
 */
function validateRefreshTokenGrant(
  params: URLSearchParams,
  res: ServerResponse,
  state: OAuthMockState,
  resource: string,
  clientId: string,
): TokenGrant | undefined {
  const refreshToken = params.get('refresh_token');
  const issuingClientId = refreshToken === null ? undefined : state.refreshTokens.get(refreshToken);
  if (refreshToken === null || issuingClientId === undefined) {
    sendJson(res, 400, { error: 'invalid_grant', error_description: 'unknown refresh token' });
    return undefined;
  }
  // RFC 6749 §6: the authorization server must ensure the refresh
  // token was issued to the client making the request. A mismatch
  // does not consume the token: the rightful client can still use it.
  if (issuingClientId !== clientId) {
    console.log(
      `[mock-mcp-http-oauth] rejected refresh token issued to another client ${clientId}`,
    );
    sendJson(res, 400, {
      error: 'invalid_grant',
      error_description: 'refresh token issued to another client',
    });
    return undefined;
  }
  state.refreshTokens.delete(refreshToken);
  return { grantType: 'refresh_token', resource, clientId };
}

/**
 * Validates one token request and consumes the redeemed authorization
 * code or refresh token. Writes the error response and returns undefined
 * when the request is invalid.
 *
 * @param params - The decoded token request parameters.
 * @param res - The server response.
 * @param state - The mock AS state.
 * @returns The validated grant, or undefined when an error response was sent.
 */
function validateTokenGrant(
  params: URLSearchParams,
  res: ServerResponse,
  state: OAuthMockState,
): TokenGrant | undefined {
  const request = validateTokenRequest(params, res, state);
  if (!request) {
    return undefined;
  }
  if (request.grantType === 'authorization_code') {
    return validateAuthorizationCodeGrant(params, res, state, request.resource, request.clientId);
  }
  if (request.grantType === 'refresh_token') {
    return validateRefreshTokenGrant(params, res, state, request.resource, request.clientId);
  }
  sendJson(res, 400, { error: 'unsupported_grant_type' });
  return undefined;
}

/**
 * Handles the token endpoint for code exchange and refresh.
 *
 * @param res - The server response.
 * @param body - The raw form-encoded request body.
 * @param state - The mock AS state.
 */
export function handleToken(res: ServerResponse, body: string, state: OAuthMockState): void {
  const params = new URLSearchParams(body);
  const grant = validateTokenGrant(params, res, state);
  if (!grant) {
    return;
  }
  const accessToken = randomToken('at');
  const refreshToken = randomToken('rt');
  state.accessTokens.add(accessToken);
  state.refreshTokens.set(refreshToken, grant.clientId);
  console.log(
    `[mock-mcp-http-oauth] issued tokens (${grant.grantType}, resource=${grant.resource})`,
  );
  sendJson(res, 200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refreshToken,
    scope: 'read write',
  });
}
