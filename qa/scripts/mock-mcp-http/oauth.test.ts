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
      `grant_type=authorization_code&code=code-1&resource=${encodeURIComponent(`${ISSUER}/mcp`)}`,
      state,
    );
    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(JSON.parse(body()).access_token).toMatch(/^at-/);
  });
});
