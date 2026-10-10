import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { handleGet } from './get-command.js';

describe('handleGet', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('prints server details for a stdio server', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        myserver: {
          type: 'stdio',
          command: 'node',
          args: ['server.js', '--port', '3000'],
          env: { NODE_ENV: 'production' },
          description: 'My test server',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const result = await handleGet(configPath, 'myserver');
    expect(result).toContain('myserver');
    expect(result).toContain('stdio');
    expect(result).toContain('node');
    expect(result).toContain('server.js');
    expect(result).toContain('NODE_ENV');
    expect(result).toContain('production');
    expect(result).toContain('My test server');
  });

  it('prints server details for an HTTP server', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        sentry: {
          type: 'http',
          url: 'https://mcp.sentry.dev/mcp',
          headers: { Authorization: 'Bearer abc123' },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const result = await handleGet(configPath, 'sentry');
    expect(result).toContain('sentry');
    expect(result).toContain('http');
    expect(result).toContain('https://mcp.sentry.dev/mcp');
    expect(result).toContain('Authorization');
  });

  it('prints a Timeout block with every configured key', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        slow: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          timeout: { startup: 60000, execution: 3600000 },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const result = await handleGet(configPath, 'slow');
    const lines = result.split('\n');
    expect(lines).toContain('Timeout:');
    expect(lines).toContain('  startup: 60000');
    expect(lines).toContain('  execution: 3600000');
  });

  it('prints only the keys present in the raw entry', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        slow: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          timeout: { execution: 900000 },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const result = await handleGet(configPath, 'slow');
    const lines = result.split('\n');
    expect(lines).toContain('Timeout:');
    expect(lines).toContain('  execution: 900000');
    expect(result).not.toContain('startup');
  });

  it('omits the Timeout block when no keys are configured', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const withoutBlock = {
      mcpServers: {
        plain: { type: 'stdio', command: 'node' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(withoutBlock));
    expect(await handleGet(configPath, 'plain')).not.toContain('Timeout:');

    const withEmptyBlock = {
      mcpServers: {
        plain: { type: 'stdio', command: 'node', timeout: {} },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(withEmptyBlock));
    expect(await handleGet(configPath, 'plain')).not.toContain('Timeout:');
  });

  it('throws when the server does not exist', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }));

    await expect(handleGet(configPath, 'nonexistent')).rejects.toThrow(
      'Server "nonexistent" not found',
    );
  });

  it('throws with available server names when server does not exist', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        alpha: { type: 'stdio', command: 'echo' },
        beta: { type: 'stdio', command: 'echo' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    await expect(handleGet(configPath, 'nonexistent')).rejects.toThrow('alpha');
    await expect(handleGet(configPath, 'nonexistent')).rejects.toThrow('beta');
  });
});
