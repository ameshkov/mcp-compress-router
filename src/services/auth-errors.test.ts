import { describe, it, expect } from 'vitest';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GuidedAuthError, isAuthError } from './index.js';

describe('GuidedAuthError', () => {
  it('is an instance of Error', () => {
    const err = new GuidedAuthError('figma');
    expect(err).toBeInstanceOf(Error);
  });

  it('is an instance of GuidedAuthError', () => {
    const err = new GuidedAuthError('figma');
    expect(err).toBeInstanceOf(GuidedAuthError);
  });

  it('carries the server name', () => {
    const err = new GuidedAuthError('figma');
    expect(err.serverName).toBe('figma');
  });

  it('has a descriptive message containing the server name', () => {
    const err = new GuidedAuthError('figma');
    expect(err.message).toContain('figma');
    expect(err.message).toContain('Authentication');
  });

  it('sets the name property to GuidedAuthError', () => {
    const err = new GuidedAuthError('figma');
    expect(err.name).toBe('GuidedAuthError');
  });
});

describe('isAuthError', () => {
  it('returns true for a GuidedAuthError instance', () => {
    expect(isAuthError(new GuidedAuthError('notion'))).toBe(true);
  });

  it('returns true for a raw invalid_token transport error', () => {
    const err = new Error(
      'Streamable HTTP error: Error POSTing to endpoint: ' +
        '{"error":"invalid_token","error_description":"Missing or invalid access token"}',
    );
    expect(isAuthError(err)).toBe(true);
  });

  it('returns true for an invalid_grant error', () => {
    expect(isAuthError(new Error('OAuth refresh failed: invalid_grant'))).toBe(true);
  });

  it('returns true for an invalid_client error', () => {
    expect(isAuthError(new Error('invalid_client: client authentication failed'))).toBe(true);
  });

  it('returns true for the "Missing or invalid access token" description', () => {
    expect(isAuthError(new Error('Request rejected: Missing or invalid access token'))).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isAuthError(new Error('INVALID_TOKEN'))).toBe(true);
    expect(isAuthError(new Error('MISSING OR INVALID ACCESS TOKEN'))).toBe(true);
  });

  it('returns true for a StreamableHTTPError carrying a 401 status', () => {
    const err = new StreamableHTTPError(401, 'Error POSTing to endpoint: forbidden');
    expect(isAuthError(err)).toBe(true);
  });

  it('returns true for a StreamableHTTPError carrying a 403 status', () => {
    const err = new StreamableHTTPError(403, 'Error POSTing to endpoint: forbidden');
    expect(isAuthError(err)).toBe(true);
  });

  it('classifies a 401 as auth even when the body has no OAuth pattern', () => {
    // A server that rejects with 401 and a plain-text body the substring
    // matcher would miss — the HTTP status is the reliable signal here.
    const err = new StreamableHTTPError(401, 'Error POSTing to endpoint: Unauthorized');
    expect(isAuthError(err)).toBe(true);
  });

  it('returns false for a StreamableHTTPError carrying a 500 status', () => {
    expect(isAuthError(new StreamableHTTPError(500, 'Internal server error'))).toBe(false);
  });

  it('returns false for a StreamableHTTPError carrying a 404 status', () => {
    expect(isAuthError(new StreamableHTTPError(404, 'Not found'))).toBe(false);
  });

  it('returns false for a JSON-RPC error code (negative, not an HTTP status)', () => {
    // McpError-style: code is a JSON-RPC code (-32601), not an HTTP status.
    const err = Object.assign(new Error('Method not found'), { code: -32601 });
    expect(isAuthError(err)).toBe(false);
  });

  it('handles string errors (not Error instances)', () => {
    expect(isAuthError('the token was invalid_token')).toBe(true);
  });

  it('returns false for a network error', () => {
    expect(isAuthError(new Error('fetch failed: ECONNREFUSED'))).toBe(false);
  });

  it('returns false for a tool-level error', () => {
    expect(isAuthError(new Error('Method not found'))).toBe(false);
  });

  it('returns false for an argument validation error', () => {
    expect(isAuthError(new Error('Invalid arguments: missing required field'))).toBe(false);
  });
});
