import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { readConfigFile, writeConfigFile, ensureConfigDir } from './config-io.js';
import { Logger } from '../utils/logger.js';
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

  it('parses JSONC files with comments and trailing commas', async () => {
    const configPath = path.join(tempDir, 'mcp.jsonc');
    const config = `{
      // A comment
      "mcpServers": {
        "foo": {
          "type": "stdio",
          "command": "echo",
          "args": ["hello",],
        },
      },
    }`;
    await fs.writeFile(configPath, config);

    const result = await readConfigFile(configPath);
    expect(result).toEqual({
      foo: { type: 'stdio', command: 'echo', args: ['hello'] },
    });
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

  it('strips the credentials key but preserves other top-level keys', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {},
        credentials: { github: { tokens: { access_token: 'secret' } } },
        otherKey: 'keep-me',
      }),
    );

    const mcpServers = { foo: { type: 'stdio', command: 'echo' } };
    await writeConfigFile(configPath, mcpServers);

    const contents = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect(parsed).not.toHaveProperty('credentials');
    expect(parsed.otherKey).toBe('keep-me');
    expect(parsed.mcpServers).toEqual(mcpServers);
  });
});

describe('credentials', () => {
  let tempDir: string;
  let configPath: string;
  let credPath: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    configPath = path.join(tempDir, 'mcp.json');
    credPath = path.join(tempDir, 'credentials.json');
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

  describe('readCredentials', () => {
    it('returns empty object when credentials.json does not exist', async () => {
      const result = await readCredentials(configPath);
      expect(result).toEqual({});
    });

    it('returns stored credentials from credentials.json', async () => {
      await writeCredentials(configPath, 'github', sampleCredentials);
      const result = await readCredentials(configPath);
      expect(result.github).toEqual(sampleCredentials);
    });

    it('throws when credentials.json contains invalid JSON', async () => {
      await fs.writeFile(credPath, 'not json {{{');

      await expect(readCredentials(configPath)).rejects.toThrow(
        /Credentials file contains invalid JSON.*credentials\.json/,
      );
    });

    it('throws when credentials.json is unreadable', async () => {
      await fs.writeFile(credPath, JSON.stringify({ github: sampleCredentials }));
      await fs.chmod(credPath, 0o000);

      try {
        await expect(readCredentials(configPath)).rejects.toThrow(
          /Failed to read credentials file.*credentials\.json/,
        );
      } finally {
        await fs.chmod(credPath, 0o644);
      }
    });

    it('throws when credentials.json is an array, not an object', async () => {
      await fs.writeFile(credPath, '[1, 2, 3]');

      await expect(readCredentials(configPath)).rejects.toThrow(
        /Credentials file must contain a JSON object/,
      );
    });
  });

  describe('writeCredentials', () => {
    it('creates credentials.json with 0600 permissions and stores entry', async () => {
      await writeCredentials(configPath, 'github', sampleCredentials);

      // Verify file exists at the right path
      const raw = await fs.readFile(credPath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual({ github: sampleCredentials });

      // Verify 0600 permissions (skip on Windows where chmod is a no-op)
      if (process.platform !== 'win32') {
        const stat = await fs.stat(credPath);
        expect(stat.mode & 0o777).toBe(0o600);
      }
    });

    it('merges with existing entries for other servers', async () => {
      // Pre-create credentials.json with "github"
      await fs.writeFile(credPath, JSON.stringify({ github: sampleCredentials }));

      // Write "notion"
      const notionCreds: StoredCredentials = {
        tokens: { access_token: 'nt-789', token_type: 'Bearer' },
      };
      await writeCredentials(configPath, 'notion', notionCreds);

      const result = await readCredentials(configPath);
      expect(result.github).toEqual(sampleCredentials);
      expect(result.notion).toEqual(notionCreds);
    });

    it('preserves existing file permissions on update', async () => {
      // Pre-create with 0644
      await fs.writeFile(credPath, JSON.stringify({ github: sampleCredentials }));

      if (process.platform !== 'win32') {
        await fs.chmod(credPath, 0o644);
      }

      const githubUpdated: StoredCredentials = {
        tokens: { access_token: 'at-new', token_type: 'Bearer' },
      };
      await writeCredentials(configPath, 'github', githubUpdated);

      if (process.platform !== 'win32') {
        const stat = await fs.stat(credPath);
        expect(stat.mode & 0o777).toBe(0o644);
      }
    });

    it('does not write credentials to mcp.json', async () => {
      // Create mcp.json first with some servers
      await fs.writeFile(
        configPath,
        JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://example.com' } } }),
      );

      await writeCredentials(configPath, 'github', sampleCredentials);

      // mcp.json should remain unchanged (no credentials key)
      const mcpRaw = await fs.readFile(configPath, 'utf-8');
      const mcpParsed = JSON.parse(mcpRaw);
      expect(mcpParsed).not.toHaveProperty('credentials');
      expect(mcpParsed.mcpServers).toBeDefined();

      // credentials.json should have the entry
      const credRaw = await fs.readFile(credPath, 'utf-8');
      const credParsed = JSON.parse(credRaw);
      expect(credParsed.github).toEqual(sampleCredentials);
    });
  });

  describe('writeCredentials with Logger (Windows path)', () => {
    it('logs a warning on Windows when chmod cannot restrict permissions', async () => {
      const logger = new Logger('info');
      const messages: string[] = [];

      // Capture stderr to collect log output
      const originalWrite = process.stderr.write.bind(process.stderr);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        const str = typeof chunk === 'string' ? chunk : String(chunk);
        messages.push(str);
        return true;
      });

      try {
        await writeCredentials(configPath, 'github', sampleCredentials, logger);

        if (process.platform === 'win32') {
          const hasWarning = messages.some((m) =>
            m.includes('File permissions cannot be restricted on Windows'),
          );
          expect(hasWarning).toBe(true);
        } else {
          // On Unix, the warning should not appear
          const hasWarning = messages.some((m) =>
            m.includes('File permissions cannot be restricted on Windows'),
          );
          expect(hasWarning).toBe(false);
        }
      } finally {
        stderrSpy.mockRestore();
        originalWrite('');
      }
    });
  });

  describe('removeCredentials', () => {
    it('is a no-op when credentials.json does not exist', async () => {
      await removeCredentials(configPath, 'github');
      // Should not throw and should not create the file
      await expect(fs.access(credPath)).rejects.toThrow();
    });

    it('removes a server entry while preserving others', async () => {
      await writeCredentials(configPath, 'github', sampleCredentials);
      await writeCredentials(configPath, 'notion', sampleCredentials);

      await removeCredentials(configPath, 'github');

      const result = await readCredentials(configPath);
      expect(result.github).toBeUndefined();
      expect(result.notion).toEqual(sampleCredentials);
    });

    it('deletes the file when last entry is removed', async () => {
      await writeCredentials(configPath, 'github', sampleCredentials);
      await removeCredentials(configPath, 'github');

      const result = await readCredentials(configPath);
      expect(result).toEqual({});

      // File should be deleted
      await expect(fs.access(credPath)).rejects.toThrow();
    });

    it('does not affect mcp.json', async () => {
      await fs.writeFile(
        configPath,
        JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://example.com' } } }),
      );
      await writeCredentials(configPath, 'github', sampleCredentials);
      await removeCredentials(configPath, 'github');

      const mcpRaw = await fs.readFile(configPath, 'utf-8');
      const mcpParsed = JSON.parse(mcpRaw);
      expect(mcpParsed).not.toHaveProperty('credentials');
    });
  });
});
