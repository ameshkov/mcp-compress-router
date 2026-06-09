import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { handleAdd } from './add-command.js';

describe('handleAdd', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
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
});
