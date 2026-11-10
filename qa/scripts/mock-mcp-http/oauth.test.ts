import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  redirectUriMatches,
  handleOAuthRequest,
  createOAuthState,
  type OAuthMockState,
} from './oauth.js';

/**
 * Builds a minimal fake ServerResponse that captures the status code,
 * headers, and body written by `handleOAuthRequest`.
 *
 * @returns The fake response plus accessors for what it captured.
 */
function captureResponse(): {
  res: ServerResponse;
  status: () => number;
  headers: () => Record<string, string>;
  body: () => string;
} {
  let status = 0;
  let headers: Record<string, string> = {};
  let body = '';
  const res = {
    writeHead: (code: number, responseHeaders?: Record<string, string>) => {
      status = code;
      headers = responseHeaders ?? {};
    },
    end: (data?: string) => {
      body = data ?? '';
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, headers: () => headers, body: () => body };
}

describe('redirectUriMatches', () => {
  it('accepts a ported request against a portless loopback registration', () => {
    expect(
      redirectUriMatches(
        'http://127.0.0.1/mcp-compress-router/oauth-callback',
        'http://127.0.0.1:54321/mcp-compress-router/oauth-callback',
      ),
    ).toBe(true);
  });

  it('rejects a localhost registration against a 127.0.0.1 request', () => {
    expect(
      redirectUriMatches(
        'http://localhost:54321/mcp-compress-router/oauth-callback',
        'http://127.0.0.1:54321/mcp-compress-router/oauth-callback',
      ),
    ).toBe(false);
  });

  it('rejects a different path on the same loopback host', () => {
    expect(
      redirectUriMatches(
        'http://127.0.0.1/mcp-compress-router/oauth-callback',
        'http://127.0.0.1:54321/other-callback',
      ),
    ).toBe(false);
  });

  it('requires an exact match for non-loopback URIs', () => {
    expect(
      redirectUriMatches('https://example.com/callback', 'https://example.com:8443/callback'),
    ).toBe(false);
    expect(redirectUriMatches('https://example.com/callback', 'https://example.com/callback')).toBe(
      true,
    );
  });
});

describe('handleOAuthRequest revoked client registrations', () => {
  const ISSUER = 'http://as.example.com';
  let state: OAuthMockState;

  beforeEach(() => {
    state = createOAuthState(ISSUER);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('revokes a client through the QA control endpoint', async () => {
    const { res, status, body } = captureResponse();
    const handled = await handleOAuthRequest(
      { method: 'POST' } as IncomingMessage,
      res,
      new URL(`${ISSUER}/test/revoke-client`),
      JSON.stringify({ client_id: 'client-1' }),
      state,
    );
    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(JSON.parse(body()).revoked).toBe('client-1');
    expect(state.revokedClients.has('client-1')).toBe(true);
  });

  it('rejects a revoked client at the authorization endpoint', async () => {
    state.revokedClients.add('revoked-client');
    const { res, status, body } = captureResponse();
    const handled = await handleOAuthRequest(
      { method: 'GET' } as IncomingMessage,
      res,
      new URL(
        `${ISSUER}/authorize?redirect_uri=http://127.0.0.1/cb&client_id=revoked-client&resource=${encodeURIComponent(`${ISSUER}/mcp`)}`,
      ),
      '',
      state,
    );
    expect(handled).toBe(true);
    expect(status()).toBe(400);
    expect(JSON.parse(body()).error).toBe('invalid_client');
  });

  it('rejects a revoked client at the token endpoint', async () => {
    state.revokedClients.add('revoked-client');
    const { res, status, body } = captureResponse();
    const handled = await handleOAuthRequest(
      { method: 'POST' } as IncomingMessage,
      res,
      new URL(`${ISSUER}/token`),
      `grant_type=refresh_token&refresh_token=rt-1&client_id=revoked-client&resource=${encodeURIComponent(`${ISSUER}/mcp`)}`,
      state,
    );
    expect(handled).toBe(true);
    expect(status()).toBe(400);
    expect(JSON.parse(body()).error).toBe('invalid_client');
  });
});

describe('handleOAuthRequest RFC 8707 resource enforcement', () => {
  const ISSUER = 'http://as.example.com';
  let state: OAuthMockState;

  beforeEach(() => {
    state = createOAuthState(ISSUER);
    // The handlers log every request; silence it so test output stays clean.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects an authorization request without a resource', async () => {
    const { res, status, body } = captureResponse();
    const handled = await handleOAuthRequest(
      { method: 'GET' } as IncomingMessage,
      res,
      new URL(`${ISSUER}/authorize?redirect_uri=http://127.0.0.1/cb&client_id=static`),
      '',
      state,
    );
    expect(handled).toBe(true);
    expect(status()).toBe(400);
    expect(JSON.parse(body()).error).toBe('invalid_target');
  });

  it('accepts an authorization request carrying a resource', async () => {
    const { res, status, headers } = captureResponse();
    const handled = await handleOAuthRequest(
      { method: 'GET' } as IncomingMessage,
      res,
      new URL(
        `${ISSUER}/authorize?redirect_uri=http://127.0.0.1/cb&client_id=static&resource=${encodeURIComponent(`${ISSUER}/mcp`)}`,
      ),
      '',
      state,
    );
    expect(handled).toBe(true);
    expect(status()).toBe(302);
    expect(headers().location).toContain('code=');
  });

  it('rejects a token request without a resource', async () => {
    state.codes.set('code-1', { clientId: 'static', redirectUri: 'http://127.0.0.1/cb' });
    const { res, status, body } = captureResponse();
    const handled = await handleOAuthRequest(
      { method: 'POST' } as IncomingMessage,
      res,
      new URL(`${ISSUER}/token`),
      'grant_type=authorization_code&code=code-1',
      state,
    );
    expect(handled).toBe(true);
    expect(status()).toBe(400);
    expect(JSON.parse(body()).error).toBe('invalid_target');
  });

  it('accepts a token request carrying a resource', async () => {
    state.codes.set('code-1', { clientId: 'static', redirectUri: 'http://127.0.0.1/cb' });
    const { res, status, body } = captureResponse();
    const handled = await handleOAuthRequest(
      { method: 'POST' } as IncomingMessage,
      res,
      new URL(`${ISSUER}/token`),
      `grant_type=authorization_code&code=code-1&client_id=static&resource=${encodeURIComponent(`${ISSUER}/mcp`)}`,
      state,
    );
    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(JSON.parse(body()).access_token).toMatch(/^at-/);
  });
});

describe('handleOAuthRequest refresh-token client binding', () => {
  const ISSUER = 'http://as.example.com';
  const RESOURCE = encodeURIComponent(`${ISSUER}/mcp`);
  let state: OAuthMockState;

  beforeEach(() => {
    state = createOAuthState(ISSUER);
    // The handlers log every request; silence it so test output stays clean.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Sends one token request to the mock.
   *
   * @param body - The form-encoded token request body.
   * @returns The captured response.
   */
  async function requestToken(body: string): Promise<ReturnType<typeof captureResponse>> {
    const captured = captureResponse();
    const handled = await handleOAuthRequest(
      { method: 'POST' } as IncomingMessage,
      captured.res,
      new URL(`${ISSUER}/token`),
      body,
      state,
    );
    expect(handled).toBe(true);
    return captured;
  }

  it('rotates a refresh token used by its issuing client', async () => {
    state.refreshTokens.set('rt-old', 'client-1');

    const first = await requestToken(
      `grant_type=refresh_token&refresh_token=rt-old&client_id=client-1&resource=${RESOURCE}`,
    );
    expect(first.status()).toBe(200);
    const rotated = JSON.parse(first.body()).refresh_token as string;
    expect(rotated).not.toBe('rt-old');
    expect(state.refreshTokens.get(rotated)).toBe('client-1');

    // The redeemed token is consumed, so replaying it fails.
    const replay = await requestToken(
      `grant_type=refresh_token&refresh_token=rt-old&client_id=client-1&resource=${RESOURCE}`,
    );
    expect(replay.status()).toBe(400);
    expect(JSON.parse(replay.body()).error).toBe('invalid_grant');
  });

  it('rejects a refresh token presented by another client', async () => {
    state.refreshTokens.set('rt-old', 'client-1');

    const rejected = await requestToken(
      `grant_type=refresh_token&refresh_token=rt-old&client_id=client-2&resource=${RESOURCE}`,
    );
    expect(rejected.status()).toBe(400);
    expect(JSON.parse(rejected.body()).error).toBe('invalid_grant');
  });

  it('does not consume a refresh token on a cross-client rejection', async () => {
    state.refreshTokens.set('rt-old', 'client-1');

    await requestToken(
      `grant_type=refresh_token&refresh_token=rt-old&client_id=client-2&resource=${RESOURCE}`,
    );
    expect(state.refreshTokens.has('rt-old')).toBe(true);

    const accepted = await requestToken(
      `grant_type=refresh_token&refresh_token=rt-old&client_id=client-1&resource=${RESOURCE}`,
    );
    expect(accepted.status()).toBe(200);
  });

  it('logs the stable cross-client rejection line', async () => {
    state.refreshTokens.set('rt-old', 'client-1');

    await requestToken(
      `grant_type=refresh_token&refresh_token=rt-old&client_id=client-2&resource=${RESOURCE}`,
    );
    expect(console.log).toHaveBeenCalledWith(
      '[mock-mcp-http-oauth] rejected refresh token issued to another client client-2',
    );
  });

  it('binds an authorization-code refresh token to the requesting client', async () => {
    state.codes.set('code-1', { clientId: 'client-1', redirectUri: 'http://127.0.0.1/cb' });

    const exchange = await requestToken(
      `grant_type=authorization_code&code=code-1&client_id=client-1&resource=${RESOURCE}`,
    );
    expect(exchange.status()).toBe(200);
    const refreshToken = JSON.parse(exchange.body()).refresh_token as string;
    expect(state.refreshTokens.get(refreshToken)).toBe('client-1');
  });
});

describe('handleOAuthRequest authorization-code client binding', () => {
  const ISSUER = 'http://as.example.com';
  const RESOURCE = encodeURIComponent(`${ISSUER}/mcp`);
  let state: OAuthMockState;

  beforeEach(() => {
    state = createOAuthState(ISSUER);
    // The handlers log every request; silence it so test output stays clean.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Sends one token request to the mock.
   *
   * @param body - The form-encoded token request body.
   * @returns The captured response.
   */
  async function requestToken(body: string): Promise<ReturnType<typeof captureResponse>> {
    const captured = captureResponse();
    const handled = await handleOAuthRequest(
      { method: 'POST' } as IncomingMessage,
      captured.res,
      new URL(`${ISSUER}/token`),
      body,
      state,
    );
    expect(handled).toBe(true);
    return captured;
  }

  it('rejects a code redeemed by another client and leaves it for its client', async () => {
    state.codes.set('code-1', { clientId: 'client-1', redirectUri: 'http://127.0.0.1/cb' });

    const rejected = await requestToken(
      `grant_type=authorization_code&code=code-1&client_id=client-2&resource=${RESOURCE}`,
    );
    expect(rejected.status()).toBe(400);
    const rejection = JSON.parse(rejected.body()) as {
      error: string;
      error_description: string;
    };
    expect(rejection.error).toBe('invalid_grant');
    expect(rejection.error_description).toBe('authorization code issued to another client');

    // No tokens are issued and the code stays available to its client.
    expect(state.accessTokens.size).toBe(0);
    expect(state.refreshTokens.size).toBe(0);
    expect(state.codes.has('code-1')).toBe(true);

    const accepted = await requestToken(
      `grant_type=authorization_code&code=code-1&client_id=client-1&resource=${RESOURCE}`,
    );
    expect(accepted.status()).toBe(200);
    const refreshToken = JSON.parse(accepted.body()).refresh_token as string;
    expect(state.refreshTokens.get(refreshToken)).toBe('client-1');
    expect(state.codes.has('code-1')).toBe(false);
  });
});
