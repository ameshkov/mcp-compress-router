import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { handleEnable } from './enable-command.js';

describe('handleEnable', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `cli-enable-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('removes the enabled field (omitted = enabled) and preserves others', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          github: {
            type: 'http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer x' },
            description: 'GitHub',
            oauth: { clientId: 'cid' },
            enabled: false,
            allowedTools: ['list_issues'],
            disabledTools: ['delete_repo'],
          },
        },
      }),
    );

    const result = await handleEnable(configPath, 'github');
    expect(result).toContain('Enabled server "github"');

    const parsed = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(parsed.mcpServers.github).not.toHaveProperty('enabled');
    expect(parsed.mcpServers.github.url).toBe('https://example.com/mcp');
    expect(parsed.mcpServers.github.headers).toEqual({ Authorization: 'Bearer x' });
    expect(parsed.mcpServers.github.oauth).toEqual({ clientId: 'cid' });
    expect(parsed.mcpServers.github.allowedTools).toEqual(['list_issues']);
    expect(parsed.mcpServers.github.disabledTools).toEqual(['delete_repo']);
  });

  it('is idempotent when enabled field is absent', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { srv: { type: 'stdio', command: 'echo' } },
      }),
    );

    const result = await handleEnable(configPath, 'srv');
    expect(result).toContain('already enabled');

    const parsed = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(parsed.mcpServers.srv).not.toHaveProperty('enabled');
  });

  it('is idempotent when enabled is explicitly true (removes the field)', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { srv: { type: 'stdio', command: 'echo', enabled: true } },
      }),
    );

    const result = await handleEnable(configPath, 'srv');
    expect(result).toContain('already enabled');

    const parsed = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(parsed.mcpServers.srv).not.toHaveProperty('enabled');
  });

  it('throws when the server does not exist', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ mcpServers: { alpha: { type: 'stdio', command: 'echo' } } }),
    );

    await expect(handleEnable(configPath, 'nonexistent')).rejects.toThrow(
      'Server "nonexistent" not found',
    );
  });
});
