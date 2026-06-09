import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { handleRemove } from './remove-command.js';
import { writeCredentials, readCredentials } from './config-io.js';
import type { StoredCredentials } from '../utils/types.js';

describe('handleRemove', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('removes an existing server from the config', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        keep: { type: 'stdio', command: 'echo' },
        removeMe: { type: 'stdio', command: 'ls' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const result = await handleRemove(configPath, 'removeMe');

    expect(result).toContain('Removed server "removeMe"');

    // Verify the file was updated
    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed.mcpServers).toHaveProperty('keep');
    expect(parsed.mcpServers).not.toHaveProperty('removeMe');
  });

  it('throws when the server does not exist', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        alpha: { type: 'stdio', command: 'echo' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    await expect(handleRemove(configPath, 'nonexistent')).rejects.toThrow(
      'Server "nonexistent" not found',
    );
  });

  it('throws with available server names when server does not exist', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        alpha: { type: 'stdio', command: 'echo' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    await expect(handleRemove(configPath, 'nonexistent')).rejects.toThrow('alpha');
  });

  it('creates the config file if it does not exist and throws', async () => {
    const configPath = path.join(tempDir, 'mcp.json');

    await expect(handleRemove(configPath, 'nonexistent')).rejects.toThrow(
      'Server "nonexistent" not found',
    );

    // Verify the empty file was created
    const contents = await fs.readFile(configPath, 'utf-8');
    expect(JSON.parse(contents)).toEqual({ mcpServers: {} });
  });

  it('clears stored OAuth credentials when removing a server', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        oauthServer: { type: 'http', url: 'https://example.com/mcp' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    // Pre-populate credentials for the server
    const sampleCreds: StoredCredentials = {
      tokens: { access_token: 'at-123', token_type: 'Bearer' },
    };
    await writeCredentials(configPath, 'oauthServer', sampleCreds);

    // Verify credentials are stored
    let creds = await readCredentials(configPath);
    expect(creds.oauthServer).toBeDefined();

    // Remove the server
    const result = await handleRemove(configPath, 'oauthServer');
    expect(result).toContain('Removed server "oauthServer"');

    // Verify credentials were cleaned up
    creds = await readCredentials(configPath);
    expect(creds.oauthServer).toBeUndefined();
  });
});
