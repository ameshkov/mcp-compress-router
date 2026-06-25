import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { handleAdd } from './add-command.js';

const { discoverAuthMock, handleLoginMock } = vi.hoisted(() => ({
  discoverAuthMock: vi.fn<(url: URL) => Promise<{ serverMetadata?: Record<string, unknown> }>>(),
  handleLoginMock: vi.fn<(configPath: string, name: string) => Promise<string>>(),
}));

vi.mock('../services/oauth-discovery.js', () => ({
  discoverAuth: discoverAuthMock,
}));

vi.mock('./login-command.js', () => ({
  handleLogin: handleLoginMock,
}));

describe('handleAdd', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
    // By default, servers do not advertise OAuth metadata.
    discoverAuthMock.mockResolvedValue({ serverMetadata: undefined });
    handleLoginMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('adds a stdio server with command and args', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const result = await handleAdd(configPath, {
      name: 'myserver',
      transport: 'stdio',
      commandOrUrl: 'npx',
      rest: ['-y', 'my-mcp-server'],
    });

    expect(result).toContain('Added server "myserver"');

    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed.mcpServers.myserver).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'my-mcp-server'],
    });
  });

  it('adds a stdio server with env vars', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const result = await handleAdd(configPath, {
      name: 'myserver',
      transport: 'stdio',
      commandOrUrl: 'node',
      rest: ['server.js'],
      env: { API_KEY: 'xxx', DEBUG: 'true' },
    });

    expect(result).toContain('Added server "myserver"');

    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed.mcpServers.myserver.env).toEqual({ API_KEY: 'xxx', DEBUG: 'true' });
  });

  it('adds an HTTP server with URL', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const result = await handleAdd(configPath, {
      name: 'sentry',
      transport: 'http',
      commandOrUrl: 'https://mcp.sentry.dev/mcp',
    });

    expect(result).toContain('Added server "sentry"');

    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed.mcpServers.sentry).toEqual({
      type: 'http',
      url: 'https://mcp.sentry.dev/mcp',
    });
  });

  it('adds an HTTP server with headers', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const result = await handleAdd(configPath, {
      name: 'sentry',
      transport: 'http',
      commandOrUrl: 'https://mcp.sentry.dev/mcp',
      headers: { Authorization: 'Bearer token123' },
    });

    expect(result).toContain('Added server "sentry"');

    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed.mcpServers.sentry.headers).toEqual({ Authorization: 'Bearer token123' });
  });

  it('auto-detects HTTP transport when URL starts with https://', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await handleAdd(configPath, {
      name: 'server',
      transport: 'stdio', // default, but URL overrides
      commandOrUrl: 'https://example.com/mcp',
    });

    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed.mcpServers.server.type).toBe('http');
    expect(parsed.mcpServers.server.url).toBe('https://example.com/mcp');
  });

  it('throws when server name already exists', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ mcpServers: { existing: { type: 'stdio', command: 'echo' } } }),
    );

    await expect(
      handleAdd(configPath, {
        name: 'existing',
        transport: 'stdio',
        commandOrUrl: 'node',
      }),
    ).rejects.toThrow('already exists');
  });

  it('creates config file on first use', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await handleAdd(configPath, {
      name: 'first',
      transport: 'stdio',
      commandOrUrl: 'echo',
    });

    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed.mcpServers.first.command).toBe('echo');
  });

  it('preserves existing servers when adding a new one', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ mcpServers: { existing: { type: 'stdio', command: 'echo' } } }),
    );

    await handleAdd(configPath, {
      name: 'newone',
      transport: 'stdio',
      commandOrUrl: 'ls',
    });

    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed.mcpServers).toHaveProperty('existing');
    expect(parsed.mcpServers).toHaveProperty('newone');
  });

  it('auto-starts OAuth login when server advertises OAuth metadata', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    discoverAuthMock.mockResolvedValue({
      serverMetadata: {
        issuer: 'https://example.com',
        authorization_endpoint: 'https://example.com/authorize',
        token_endpoint: 'https://example.com/token',
      },
    });
    handleLoginMock.mockResolvedValue('Successfully authenticated server "github".');

    const result = await handleAdd(configPath, {
      name: 'github',
      transport: 'http',
      commandOrUrl: 'https://example.com/mcp',
    });

    expect(discoverAuthMock).toHaveBeenCalledWith(new URL('https://example.com/mcp'));
    expect(handleLoginMock).toHaveBeenCalledWith(configPath, 'github');
    expect(result).toContain('Added server "github" (http).');
    expect(result).toContain('Successfully authenticated server "github".');
  });

  it('caches authRequirement "oauth" when the server advertises OAuth', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    discoverAuthMock.mockResolvedValue({
      serverMetadata: {
        issuer: 'https://example.com',
        authorization_endpoint: 'https://example.com/authorize',
        token_endpoint: 'https://example.com/token',
      },
    });
    handleLoginMock.mockResolvedValue('Successfully authenticated server "github".');

    await handleAdd(configPath, {
      name: 'github',
      transport: 'http',
      commandOrUrl: 'https://example.com/mcp',
    });

    const credPath = path.join(tempDir, 'credentials.json');
    const parsed = JSON.parse(await fs.readFile(credPath, 'utf-8'));
    expect(parsed.github.authRequirement).toBe('oauth');
    expect(parsed.github.checkedAt).toBeTruthy();
  });

  it('caches authRequirement "none" when the server has no OAuth metadata', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    discoverAuthMock.mockResolvedValue({ serverMetadata: undefined });

    await handleAdd(configPath, {
      name: 'plain',
      transport: 'http',
      commandOrUrl: 'https://example.com/mcp',
    });

    const credPath = path.join(tempDir, 'credentials.json');
    const parsed = JSON.parse(await fs.readFile(credPath, 'utf-8'));
    expect(parsed.plain.authRequirement).toBe('none');
    expect(parsed.plain.checkedAt).toBeTruthy();
    expect(parsed.plain.tokens).toBeUndefined();
  });

  it('caches authRequirement "unknown" when the probe throws', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    discoverAuthMock.mockRejectedValue(new Error('network down'));

    await handleAdd(configPath, {
      name: 'flaky',
      transport: 'http',
      commandOrUrl: 'https://example.com/mcp',
    });

    const credPath = path.join(tempDir, 'credentials.json');
    const parsed = JSON.parse(await fs.readFile(credPath, 'utf-8'));
    expect(parsed.flaky.authRequirement).toBe('unknown');
    expect(handleLoginMock).not.toHaveBeenCalled();
  });

  it('does not start login when server has no OAuth metadata', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const result = await handleAdd(configPath, {
      name: 'plain',
      transport: 'http',
      commandOrUrl: 'https://example.com/mcp',
    });

    expect(discoverAuthMock).toHaveBeenCalledWith(new URL('https://example.com/mcp'));
    expect(handleLoginMock).not.toHaveBeenCalled();
    expect(result).toBe('Added server "plain" (http).');
  });

  it('adds a stdio server with description', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const result = await handleAdd(configPath, {
      name: 'myserver',
      transport: 'stdio',
      commandOrUrl: 'npx',
      rest: ['-y', 'my-mcp-server'],
      description: 'My custom MCP server',
    });

    expect(result).toContain('Added server "myserver"');

    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed.mcpServers.myserver.description).toBe('My custom MCP server');
  });

  it('adds an HTTP server with description', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const result = await handleAdd(configPath, {
      name: 'sentry',
      transport: 'http',
      commandOrUrl: 'https://mcp.sentry.dev/mcp',
      description: 'Sentry error tracking tools',
    });

    expect(result).toContain('Added server "sentry"');

    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed.mcpServers.sentry.description).toBe('Sentry error tracking tools');
  });

  it('does not write description when not provided', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await handleAdd(configPath, {
      name: 'plain',
      transport: 'stdio',
      commandOrUrl: 'echo',
    });

    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed.mcpServers.plain.description).toBeUndefined();
  });

  it('writes "enabled": false when --disabled is passed', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await handleAdd(configPath, {
      name: 'github',
      transport: 'stdio',
      commandOrUrl: 'npx',
      rest: ['-y', 'server-github'],
      disabled: true,
      allowedTools: ['list_issues'],
    });

    const parsed = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(parsed.mcpServers.github.enabled).toBe(false);
    expect(parsed.mcpServers.github.allowedTools).toEqual(['list_issues']);
  });

  it('writes no enabled field when --enabled is passed', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await handleAdd(configPath, {
      name: 'fs',
      transport: 'stdio',
      commandOrUrl: 'npx',
      rest: ['-y', 'fs-server'],
      enabled: true,
      disabledTools: ['delete_*'],
    });

    const parsed = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(parsed.mcpServers.fs.enabled).toBeUndefined();
    expect(parsed.mcpServers.fs.disabledTools).toEqual(['delete_*']);
  });

  it('writes no enable/filter fields when no selection flags are passed', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await handleAdd(configPath, {
      name: 'x',
      transport: 'stdio',
      commandOrUrl: 'npx',
      rest: ['-y', 'x-server'],
    });

    const parsed = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(parsed.mcpServers.x.enabled).toBeUndefined();
    expect(parsed.mcpServers.x.allowedTools).toBeUndefined();
    expect(parsed.mcpServers.x.disabledTools).toBeUndefined();
  });

  it('collects repeated --allowed-tools values in order', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await handleAdd(configPath, {
      name: 'y',
      transport: 'stdio',
      commandOrUrl: 'npx',
      rest: ['-y', 'y-server'],
      allowedTools: ['a', 'b'],
    });

    const parsed = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(parsed.mcpServers.y.allowedTools).toEqual(['a', 'b']);
  });

  it('throws and writes nothing when an allowed-tools glob is invalid', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await expect(
      handleAdd(configPath, {
        name: 'z',
        transport: 'stdio',
        commandOrUrl: 'npx',
        rest: ['-y', 'z-server'],
        allowedTools: ['[unclosed'],
      }),
    ).rejects.toThrow(/allowedTools.*\[unclosed/);

    await expect(fs.access(configPath)).rejects.toThrow();
  });

  it('throws and writes nothing when a disabled-tools glob is invalid', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await expect(
      handleAdd(configPath, {
        name: 'z2',
        transport: 'stdio',
        commandOrUrl: 'npx',
        rest: ['-y', 'z-server'],
        disabledTools: ['{a,b'],
      }),
    ).rejects.toThrow(/disabledTools.*\{a,b/);

    await expect(fs.access(configPath)).rejects.toThrow();
  });

  it('throws when both --enabled and --disabled are passed', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await expect(
      handleAdd(configPath, {
        name: 'both',
        transport: 'stdio',
        commandOrUrl: 'npx',
        rest: ['-y', 'both-server'],
        enabled: true,
        disabled: true,
      }),
    ).rejects.toThrow(/--enabled.*--disabled|mutually exclusive/i);

    await expect(fs.access(configPath)).rejects.toThrow();
  });
});
