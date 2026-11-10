import { describe, it, expect } from 'vitest';
import { LOGIN_INTERACTIVE_NOTE, buildLoginCommand, buildLogoutCommand } from './login-guidance.js';

describe('buildLoginCommand', () => {
  it('builds the npx login command for a server name', () => {
    expect(buildLoginCommand('figma')).toBe('npx mcp-compress-router login figma');
  });

  it('interpolates the server name verbatim', () => {
    expect(buildLoginCommand('my-server')).toBe('npx mcp-compress-router login my-server');
  });
});

describe('buildLogoutCommand', () => {
  it('builds the npx logout command for a server name', () => {
    expect(buildLogoutCommand('figma')).toBe('npx mcp-compress-router logout figma');
  });

  it('interpolates the server name verbatim', () => {
    expect(buildLogoutCommand('my-server')).toBe('npx mcp-compress-router logout my-server');
  });
});

describe('LOGIN_INTERACTIVE_NOTE', () => {
  it('tells the agent not to run the command itself', () => {
    expect(LOGIN_INTERACTIVE_NOTE).toContain('Do not run it yourself');
  });

  it('explains that the authorization flow is interactive', () => {
    expect(LOGIN_INTERACTIVE_NOTE).toContain('interactive authorization');
  });
});
