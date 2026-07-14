import { describe, it, expect } from 'vitest';
import { buildGuidedError, GuidedAuthError } from './index.js';
import type { DownstreamServerConfig } from '../utils/index.js';

const httpServer: DownstreamServerConfig = {
  name: 'figma',
  type: 'http',
  url: 'https://api.figma.com/mcp',
};

const stdioServer: DownstreamServerConfig = {
  name: 'github',
  type: 'stdio',
  command: 'npx',
  args: ['@some/mcp-server'],
};

describe('buildGuidedError', () => {
  it('returns an Error (not a thrown value)', () => {
    const err = buildGuidedError(httpServer, new GuidedAuthError('figma'), 'unauthorized', false);
    expect(err).toBeInstanceOf(Error);
  });

  it('includes the server name in the message', () => {
    const err = buildGuidedError(httpServer, new GuidedAuthError('figma'), 'unauthorized', false);
    expect(err.message).toContain('figma');
  });

  it('includes the underlying error message', () => {
    const underlying = new Error('fetch failed: ECONNREFUSED');
    const err = buildGuidedError(httpServer, underlying, 'unavailable', false);
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('includes "npx mcp-compress-router login" for unauthorized HTTP servers', () => {
    const err = buildGuidedError(httpServer, new GuidedAuthError('figma'), 'unauthorized', false);
    expect(err.message).toContain('npx mcp-compress-router login figma');
  });

  it('suggests the login command for an unauthorized server (not network advice)', () => {
    const underlying = new Error(
      'Streamable HTTP error: Error POSTing to endpoint: ' +
        '{"error":"invalid_token","error_description":"Missing or invalid access token"}',
    );
    const err = buildGuidedError(
      { name: 'notion', type: 'http', url: 'https://mcp.notion.com/mcp' },
      underlying,
      'unauthorized',
      true,
    );
    expect(err.message).toContain('npx mcp-compress-router login notion');
    expect(err.message).toContain('authentication is required');
    expect(err.message).not.toContain('Verify the server is running');
  });

  it('does not name specific coding agents in the restart guidance', () => {
    const err = buildGuidedError(httpServer, new Error('ECONNREFUSED'), 'unavailable', false);
    expect(err.message).not.toContain('Claude Code');
    expect(err.message).not.toContain('opencode');
    expect(err.message).not.toContain('Codex');
  });

  it('includes restart guidance for unavailable servers', () => {
    const err = buildGuidedError(httpServer, new Error('ECONNREFUSED'), 'unavailable', false);
    expect(err.message).toContain('restart');
  });

  it('includes "restart the MCP server" guidance for all statuses', () => {
    const authErr = buildGuidedError(
      httpServer,
      new GuidedAuthError('figma'),
      'unauthorized',
      false,
    );
    const unavailErr = buildGuidedError(httpServer, new Error('timeout'), 'unavailable', false);
    expect(authErr.message).toContain('restart');
    expect(unavailErr.message).toContain('restart');
  });

  it('notes when recovery was attempted', () => {
    const err = buildGuidedError(httpServer, new GuidedAuthError('figma'), 'unauthorized', true);
    expect(err.message).toMatch(/recovery was attempted|Automatic recovery/);
  });

  it('mentions PATH for stdio ENOENT errors', () => {
    const err = buildGuidedError(
      stdioServer,
      new Error('spawn /nonexistent/command ENOENT'),
      'unavailable',
      false,
    );
    expect(err.message).toContain('PATH');
  });

  it('handles string errors (not just Error instances)', () => {
    const err = buildGuidedError(httpServer, 'string error message', 'unavailable', false);
    expect(err.message).toContain('string error message');
  });
});
