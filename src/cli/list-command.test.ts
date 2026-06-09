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

  it('prints nothing when no servers are configured', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }));

    const result = await handleList(configPath);
    expect(result).toBe('');
  });

  it('lists all configured servers with their types', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        server1: { type: 'stdio', command: 'node', args: ['server1.js'] },
        server2: { type: 'http', url: 'https://example.com/mcp' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const result = await handleList(configPath);
    expect(result).toContain('server1');
    expect(result).toContain('server2');
  });

  it('creates the config file if it does not exist', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const result = await handleList(configPath);
    expect(result).toBe('');

    // Verify the file was created
    const contents = await fs.readFile(configPath, 'utf-8');
    expect(JSON.parse(contents)).toEqual({ mcpServers: {} });
  });
});
