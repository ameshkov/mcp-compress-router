import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { readConfigFile, writeConfigFile, ensureConfigDir } from './config-io.js';
import type { StoredCredentials } from '../utils/types.js';

// Re-import for credential tests
import { readCredentials, writeCredentials, removeCredentials } from './config-io.js';

describe('ensureConfigDir', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates the directory and empty mcpServers file if it does not exist', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await ensureConfigDir(configPath);

    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed).toEqual({ mcpServers: {} });
  });

  it('does not overwrite an existing config file', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ mcpServers: { existing: { type: 'stdio', command: 'node' } } }),
    );

    await ensureConfigDir(configPath);

    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed.mcpServers).toHaveProperty('existing');
  });
});

describe('readConfigFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('reads an existing mcpServers object', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = { mcpServers: { foo: { type: 'stdio', command: 'echo' } } };
    await fs.writeFile(configPath, JSON.stringify(config));

    const result = await readConfigFile(configPath);
    expect(result).toEqual({ foo: { type: 'stdio', command: 'echo' } });
  });

  it('throws if the file contains invalid JSON', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, 'not json');

    await expect(readConfigFile(configPath)).rejects.toThrow('Failed to parse');
  });

  it('throws if the file has no mcpServers key', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify({ other: true }));

    await expect(readConfigFile(configPath)).rejects.toThrow('mcpServers');
  });
});

describe('writeConfigFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes the mcpServers object to the file', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }));

    const mcpServers = { foo: { type: 'stdio', command: 'echo' } };
    await writeConfigFile(configPath, mcpServers);

    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed).toEqual({ mcpServers: mcpServers });
  });

  it('preserves top-level keys other than mcpServers', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {}, otherKey: 'keep-me' }));

    const mcpServers = { foo: { type: 'stdio', command: 'echo' } };
    await writeConfigFile(configPath, mcpServers);

    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed.otherKey).toBe('keep-me');
    expect(parsed.mcpServers).toEqual(mcpServers);
  });
});

describe('credentials', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const sampleCredentials: StoredCredentials = {
    clientRegistration: { client_id: 'abc', client_secret: 'xyz' },
    tokens: {
      access_token: 'at-123',
      refresh_token: 'rt-456',
      expires_in: 3600,
      scope: 'read write',
      token_type: 'Bearer',
    },
  };

  it('readCredentials returns empty object when file is empty', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await ensureConfigDir(configPath);
    const result = await readCredentials(configPath);
    expect(result).toEqual({});
  });

  it('readCredentials returns stored credentials', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await ensureConfigDir(configPath);
    await writeCredentials(configPath, 'github', sampleCredentials);
    const result = await readCredentials(configPath);
    expect(result.github).toEqual(sampleCredentials);
  });

  it('readCredentials throws when config file contains invalid JSON', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, 'not json {{{');

    await expect(readCredentials(configPath)).rejects.toThrow(
      'Failed to read credentials from config file',
    );
  });

  it('readCredentials throws when config file is unreadable', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await ensureConfigDir(configPath);
    await fs.chmod(configPath, 0o000);

    try {
      await expect(readCredentials(configPath)).rejects.toThrow(
        'Failed to read credentials from config file',
      );
    } finally {
      // Restore permissions so afterEach cleanup doesn't fail
      await fs.chmod(configPath, 0o644);
    }
  });

  it('writeCredentials preserves mcpServers', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await ensureConfigDir(configPath);
    await writeConfigFile(configPath, { test: { type: 'stdio', command: 'ls' } });
    await writeCredentials(configPath, 'github', sampleCredentials);
    const servers = await readConfigFile(configPath);
    expect(servers.test).toBeDefined();
    const creds = await readCredentials(configPath);
    expect(creds.github).toEqual(sampleCredentials);
  });

  it('removeCredentials deletes credentials for a server', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await ensureConfigDir(configPath);
    await writeCredentials(configPath, 'github', sampleCredentials);
    await writeCredentials(configPath, 'notion', sampleCredentials);
    await removeCredentials(configPath, 'github');
    const result = await readCredentials(configPath);
    expect(result.github).toBeUndefined();
    expect(result.notion).toEqual(sampleCredentials);
  });

  it('removeCredentials is a no-op for unknown server', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await ensureConfigDir(configPath);
    await removeCredentials(configPath, 'nonexistent');
  });
});
