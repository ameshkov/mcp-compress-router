import { describe, it, expect } from 'vitest';
import { validateOAuthClientName, validateOAuthClientUri } from './validate-oauth-client.js';

describe('validateOAuthClientName', () => {
  it('returns the trimmed client name', () => {
    expect(validateOAuthClientName('  My Client  ', 'oauth.clientName')).toBe('My Client');
  });

  it('rejects an empty name with the field name in the message', () => {
    expect(() => validateOAuthClientName('', 'oauth.clientName')).toThrow(
      'oauth.clientName must be a non-empty string',
    );
  });

  it('rejects a whitespace-only name', () => {
    expect(() => validateOAuthClientName('   ', '--client-name')).toThrow(/non-empty/);
  });
});

describe('validateOAuthClientUri', () => {
  it('accepts an absolute https URL unchanged', () => {
    expect(validateOAuthClientUri('https://example.com/app', 'oauth.clientUri')).toBe(
      'https://example.com/app',
    );
  });

  it('accepts an absolute http URL unchanged', () => {
    expect(validateOAuthClientUri('http://example.com', 'oauth.clientUri')).toBe(
      'http://example.com',
    );
  });

  it('trims surrounding whitespace before validating and returns the trimmed URI', () => {
    expect(validateOAuthClientUri('  https://example.com/app  ', '--client-uri')).toBe(
      'https://example.com/app',
    );
  });

  it('rejects a relative URL with the field name in the message', () => {
    expect(() => validateOAuthClientUri('/callback', 'oauth.clientUri')).toThrow(
      'oauth.clientUri must be an absolute http(s) URL',
    );
  });

  it('rejects a non-http(s) scheme', () => {
    expect(() => validateOAuthClientUri('ftp://example.com', '--client-uri')).toThrow(
      /absolute http\(s\) URL/,
    );
  });

  it('rejects a string that is not a URL at all', () => {
    expect(() => validateOAuthClientUri('not a url', '--client-uri')).toThrow(/absolute/);
  });
});
