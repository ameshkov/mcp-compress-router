import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Tests for the optional `enabled`, `allowedTools`, and `disabledTools`
 * fields parsed and validated by `loadConfig`. Split from
 * `config-load.test.ts` to keep each test file focused and under the
 * project's line-count gate.
 */
describe('loadConfig — enabled / allowedTools / disabledTools', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('defaults enabled to undefined when omitted (treated as true downstream)', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { srv: { type: 'stdio', command: 'node' } },
      }),
    );
    const servers = await loadConfig(configPath);
    expect(servers[0].enabled).toBeUndefined();
    expect(servers[0].allowedTools).toBeUndefined();
    expect(servers[0].disabledTools).toBeUndefined();
  });

  it('passes through valid enabled, allowedTools, and disabledTools', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          srv: {
            type: 'stdio',
            command: 'node',
            enabled: false,
            allowedTools: ['list_issues', 'get_pull_request'],
            disabledTools: ['delete_repo'],
          },
        },
      }),
    );
    const servers = await loadConfig(configPath);
    expect(servers[0].enabled).toBe(false);
    expect(servers[0].allowedTools).toEqual(['list_issues', 'get_pull_request']);
    expect(servers[0].disabledTools).toEqual(['delete_repo']);
  });

  it('allows an empty allowedTools array (means no tools)', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { srv: { type: 'stdio', command: 'node', allowedTools: [] } },
      }),
    );
    const servers = await loadConfig(configPath);
    expect(servers[0].allowedTools).toEqual([]);
  });

  it('allows both allowedTools and disabledTools together (precedence later)', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          srv: {
            type: 'stdio',
            command: 'node',
            allowedTools: ['a', 'b'],
            disabledTools: ['b'],
          },
        },
      }),
    );
    const servers = await loadConfig(configPath);
    expect(servers[0].allowedTools).toEqual(['a', 'b']);
    expect(servers[0].disabledTools).toEqual(['b']);
  });

  it('rejects enabled set to a non-boolean string', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { srv: { type: 'stdio', command: 'node', enabled: 'yes' } },
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(/"srv".*"enabled"/);
  });

  it('rejects enabled set to a number', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { srv: { type: 'stdio', command: 'node', enabled: 1 } },
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(/"srv".*"enabled"/);
  });

  it('rejects allowedTools as a string instead of an array', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          srv: { type: 'stdio', command: 'node', allowedTools: 'list_issues' },
        },
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(/"srv".*"allowedTools"/);
  });

  it('rejects allowedTools array containing a non-string', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          srv: { type: 'stdio', command: 'node', allowedTools: ['ok', 5] },
        },
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(/"srv".*"allowedTools"/);
  });

  it('rejects allowedTools array containing an empty string', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          srv: { type: 'stdio', command: 'node', allowedTools: [''] },
        },
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(/"srv".*"allowedTools"/);
  });

  it('rejects disabledTools as null', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { srv: { type: 'stdio', command: 'node', disabledTools: null } },
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(/"srv".*"disabledTools"/);
  });

  it('rejects an invalid glob in allowedTools (unclosed bracket)', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          srv: { type: 'stdio', command: 'node', allowedTools: ['[unclosed'] },
        },
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(/"srv".*"allowedTools".*\[unclosed/);
  });

  it('rejects an invalid glob in disabledTools (unclosed brace)', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          srv: { type: 'stdio', command: 'node', disabledTools: ['{a,b'] },
        },
      }),
    );
    await expect(loadConfig(configPath)).rejects.toThrow(/"srv".*"disabledTools".*\{a,b/);
  });

  it('accepts valid glob patterns with wildcards and braces', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          srv: {
            type: 'stdio',
            command: 'node',
            allowedTools: ['file_*', '*_read', '{create,update}_thing'],
          },
        },
      }),
    );
    const servers = await loadConfig(configPath);
    expect(servers[0].allowedTools).toEqual(['file_*', '*_read', '{create,update}_thing']);
  });
});
