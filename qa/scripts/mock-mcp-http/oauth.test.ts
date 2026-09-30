import { describe, it, expect } from 'vitest';
import { redirectUriMatches } from './oauth.js';

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
