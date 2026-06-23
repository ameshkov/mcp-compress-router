import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { handleList } from './list-command.js';

describe('handleList', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** Writes an mcp.json with the given mcpServers object. */
  async function writeConfig(servers: Record<string, unknown>): Promise<string> {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: servers }, null, 2));
    return configPath;
  }

  /** Writes a credentials.json alongside the config. */
  async function writeCredentials(creds: Record<string, unknown>): Promise<void> {
    await fs.writeFile(path.join(tempDir, 'credentials.json'), JSON.stringify(creds, null, 2));
  }

  it('prints only the config path when no servers are configured', async () => {
    const configPath = await writeConfig({});
    const result = await handleList(configPath);
    expect(result).toBe(`Configuration was loaded from ${configPath}`);
  });

  it('creates the config file if it does not exist', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const result = await handleList(configPath);
    expect(result).toBe(`Configuration was loaded from ${configPath}`);

    const contents = await fs.readFile(configPath, 'utf-8');
    expect(JSON.parse(contents)).toEqual({ mcpServers: {} });
  });

  it('shows "none" auth for a stdio server', async () => {
    const configPath = await writeConfig({
      local: { type: 'stdio', command: 'npx', args: ['-y', 'fs-server'] },
    });
    const result = await handleList(configPath);

    expect(result).toContain('Name');
    expect(result).toContain('Auth');
    expect(result).toContain('local');
    expect(result).toContain('stdio');
    expect(result).toContain('npx -y fs-server');
    expect(result).toContain('none');
  });

  it('shows "authenticated" for an OAuth server with stored tokens', async () => {
    const configPath = await writeConfig({
      github: { type: 'http', url: 'https://api.github.com/mcp' },
    });
    await writeCredentials({
      github: {
        authRequirement: 'oauth',
        tokens: { access_token: 'at', token_type: 'Bearer' },
      },
    });

    const result = await handleList(configPath);
    expect(result).toContain('authenticated');
    expect(result).toContain('https://api.github.com/mcp');
  });

  it('shows "requires login" for an OAuth server without tokens', async () => {
    const configPath = await writeConfig({
      notion: { type: 'http', url: 'https://api.notion.com/mcp' },
    });
    await writeCredentials({ notion: { authRequirement: 'oauth' } });

    const result = await handleList(configPath);
    expect(result).toContain('requires login');
  });

  it('shows "public" for an HTTP server that does not advertise OAuth', async () => {
    const configPath = await writeConfig({
      api: { type: 'http', url: 'https://example.com/mcp' },
    });
    await writeCredentials({ api: { authRequirement: 'none' } });

    const result = await handleList(configPath);
    expect(result).toContain('public');
  });

  it('shows "unknown" when no credentials entry exists', async () => {
    const configPath = await writeConfig({
      api: { type: 'http', url: 'https://example.com/mcp' },
    });

    const result = await handleList(configPath);
    expect(result).toContain('unknown');
  });

  it('shows "header" for an HTTP server with a configured Authorization header', async () => {
    const configPath = await writeConfig({
      api: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer token' },
      },
    });

    const result = await handleList(configPath);
    expect(result).toContain('header');
  });

  it('renders a mixed set of servers with aligned columns and no trailing whitespace', async () => {
    const configPath = await writeConfig({
      'local-fs': {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
      },
      github: { type: 'http', url: 'https://api.github.com/mcp' },
      'my-api': { type: 'http', url: 'https://example.com/mcp' },
    });
    await writeCredentials({
      github: {
        authRequirement: 'oauth',
        tokens: { access_token: 'at', token_type: 'Bearer' },
      },
      'my-api': { authRequirement: 'none' },
    });

    const result = await handleList(configPath);
    const lines = result.split('\n');

    // header, blank line, column header, then one row per server
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe(`Configuration was loaded from ${configPath}`);
    expect(lines[1]).toBe('');

    const headerLine = lines[2];
    expect(headerLine).toContain('Name');
    expect(headerLine).toContain('Type');
    expect(headerLine).toContain('CommandOrUrl');
    expect(headerLine).toContain('Auth');

    const dataLines = lines.slice(3);
    expect(dataLines[0]).toMatch(/none$/);
    expect(dataLines[1]).toMatch(/authenticated$/);
    expect(dataLines[2]).toMatch(/public$/);

    // No line should carry trailing whitespace.
    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
  });
});
