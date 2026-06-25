import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { handleDisable } from './disable-command.js';

describe('handleDisable', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `cli-disable-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('sets enabled=false and preserves all other fields', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          github: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'server-github'],
            env: { TOKEN: 'abc' },
            description: 'GitHub',
            allowedTools: ['list_issues'],
            disabledTools: ['delete_repo'],
          },
        },
      }),
    );

    const result = await handleDisable(configPath, 'github');
    expect(result).toContain('Disabled server "github"');

    const parsed = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(parsed.mcpServers.github.enabled).toBe(false);
    expect(parsed.mcpServers.github.command).toBe('npx');
    expect(parsed.mcpServers.github.args).toEqual(['-y', 'server-github']);
    expect(parsed.mcpServers.github.env).toEqual({ TOKEN: 'abc' });
    expect(parsed.mcpServers.github.description).toBe('GitHub');
    expect(parsed.mcpServers.github.allowedTools).toEqual(['list_issues']);
    expect(parsed.mcpServers.github.disabledTools).toEqual(['delete_repo']);
  });

  it('is idempotent when already disabled (enabled: false)', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { srv: { type: 'stdio', command: 'echo', enabled: false } },
      }),
    );

    const result = await handleDisable(configPath, 'srv');
    expect(result).toContain('already disabled');

    const parsed = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(parsed.mcpServers.srv.enabled).toBe(false);
  });

  it('throws when the server does not exist', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ mcpServers: { alpha: { type: 'stdio', command: 'echo' } } }),
    );

    await expect(handleDisable(configPath, 'nonexistent')).rejects.toThrow(
      'Server "nonexistent" not found',
    );
  });

  it('creates the config file if missing and throws not-found', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await expect(handleDisable(configPath, 'nope')).rejects.toThrow('Server "nope" not found');
    expect(JSON.parse(await fs.readFile(configPath, 'utf-8'))).toEqual({
      mcpServers: {},
    });
  });
});
