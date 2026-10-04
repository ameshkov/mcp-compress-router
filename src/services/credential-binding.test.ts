import { describe, it, expect } from 'vitest';
import { credentialsUsableFor, resolveBindingUrl } from './credential-binding.js';
import type { StoredCredentials } from '../utils/types.js';

/** An entry carrying both a client registration and tokens. */
function fullEntry(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
  return {
    serverUrl: 'https://example.com/mcp',
    issuer: 'https://auth.example.com/',
    clientRegistration: { client_id: 'client-1' },
    tokens: { access_token: 'at-1', token_type: 'Bearer' },
    ...overrides,
  };
}

describe('credentialsUsableFor', () => {
  it('accepts an absent entry (nothing to leak)', () => {
    expect(credentialsUsableFor(undefined, 'https://example.com/mcp')).toBe(true);
  });

  it('accepts a probe-only entry regardless of its recorded URL', () => {
    // Probe-only entries carry no credential material, so a stale
    // serverUrl cannot leak anything.
    const probeOnly: StoredCredentials = {
      serverUrl: 'https://old.example.com/mcp',
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    };
    expect(credentialsUsableFor(probeOnly, 'https://example.com/mcp')).toBe(true);
  });

  it('accepts credentials bound to the same URL', () => {
    expect(credentialsUsableFor(fullEntry(), 'https://example.com/mcp')).toBe(true);
  });

  it('treats an origin URL with and without a trailing slash as equal', () => {
    const entry = fullEntry({ serverUrl: 'https://example.com/' });
    expect(credentialsUsableFor(entry, 'https://example.com')).toBe(true);
  });

  it('normalizes host case and the default port', () => {
    const entry = fullEntry({ serverUrl: 'https://EXAMPLE.com:443/mcp' });
    expect(credentialsUsableFor(entry, 'https://example.com/mcp')).toBe(true);
  });

  it('keeps a trailing slash on a non-origin path significant', () => {
    expect(credentialsUsableFor(fullEntry(), 'https://example.com/mcp/')).toBe(false);
    expect(
      credentialsUsableFor(
        fullEntry({ serverUrl: 'https://example.com/mcp/' }),
        'https://example.com/mcp',
      ),
    ).toBe(false);
  });

  it('rejects credentials bound to a different URL', () => {
    expect(credentialsUsableFor(fullEntry(), 'https://different.example.org/mcp')).toBe(false);
  });

  it('rejects a client registration bound to a different URL', () => {
    const entry: StoredCredentials = {
      serverUrl: 'https://example.com/mcp',
      clientRegistration: { client_id: 'client-1' },
    };
    expect(credentialsUsableFor(entry, 'https://different.example.org/mcp')).toBe(false);
  });

  it('adopts legacy credentials without a recorded URL', () => {
    const legacy: StoredCredentials = {
      clientRegistration: { client_id: 'client-1' },
      tokens: { access_token: 'at-1', token_type: 'Bearer' },
    };
    expect(credentialsUsableFor(legacy, 'https://different.example.org/mcp')).toBe(true);
  });

  it('rejects credentials when the recorded URL is malformed', () => {
    const entry = fullEntry({ serverUrl: 'not a url' });
    expect(credentialsUsableFor(entry, 'https://example.com/mcp')).toBe(false);
  });

  it('rejects credentials when the current URL is missing or malformed', () => {
    expect(credentialsUsableFor(fullEntry(), undefined)).toBe(false);
    expect(credentialsUsableFor(fullEntry(), 'not a url')).toBe(false);
  });

  it('rejects credentials from a different issuer when both are known', () => {
    const entry = fullEntry({ issuer: 'https://old-auth.example.com/' });
    expect(
      credentialsUsableFor(entry, 'https://example.com/mcp', 'https://auth.example.com/'),
    ).toBe(false);
  });

  it('accepts credentials from the same issuer', () => {
    expect(
      credentialsUsableFor(fullEntry(), 'https://example.com/mcp', 'https://auth.example.com/'),
    ).toBe(true);
  });

  it('ignores the issuer check when the entry or the caller has no issuer', () => {
    const noIssuer = fullEntry({ issuer: undefined });
    expect(
      credentialsUsableFor(noIssuer, 'https://example.com/mcp', 'https://auth.example.com/'),
    ).toBe(true);
    expect(credentialsUsableFor(fullEntry(), 'https://example.com/mcp')).toBe(true);
  });
});

describe('resolveBindingUrl', () => {
  it('normalizes the current server URL when the entry is unbound', () => {
    expect(resolveBindingUrl(undefined, 'https://example.com')).toBe('https://example.com/');
  });

  it('preserves an existing binding even when it differs from the current URL', () => {
    const entry = fullEntry({ serverUrl: 'https://old.example.com/mcp' });
    expect(resolveBindingUrl(entry, 'https://example.com/mcp')).toBe('https://old.example.com/mcp');
  });

  it('re-binds a probe-only entry to the current URL', () => {
    // A probe-only entry has no credentials to protect; inheriting its
    // stale URL would stamp fresh credentials with the wrong binding.
    const probeOnly: StoredCredentials = {
      serverUrl: 'https://old.example.com/mcp',
      authRequirement: 'oauth',
    };
    expect(resolveBindingUrl(probeOnly, 'https://example.com/mcp')).toBe('https://example.com/mcp');
  });

  it('returns undefined when the current URL is missing or malformed and no binding exists', () => {
    expect(resolveBindingUrl(undefined, undefined)).toBeUndefined();
    expect(resolveBindingUrl(undefined, 'not a url')).toBeUndefined();
  });
});
