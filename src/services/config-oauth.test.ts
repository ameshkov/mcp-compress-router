import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

describe('loadConfig — oauth block', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('parses oauth block with ${VAR} expansion', async () => {
    process.env.TEST_CLIENT_ID = 'my-client';
    process.env.TEST_CLIENT_SECRET = 'my-secret';
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        github: {
          type: 'http',
          url: 'https://api.github.com/mcp',
          description: 'GitHub API tools',
          oauth: {
            clientId: '${TEST_CLIENT_ID}',
            clientSecret: '${TEST_CLIENT_SECRET}',
            scope: 'repo user',
          },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    const servers = await loadConfig(configPath);
    expect(servers[0].oauth).toEqual({
      clientId: 'my-client',
      clientSecret: 'my-secret',
      scope: 'repo user',
    });
    delete process.env.TEST_CLIENT_ID;
    delete process.env.TEST_CLIENT_SECRET;
  });

  it('rejects oauth block with unresolved ${VAR} in clientId', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        github: {
          type: 'http',
          url: 'https://api.github.com/mcp',
          description: 'GitHub API tools',
          oauth: { clientId: '${MISSING_VAR}' },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    await expect(loadConfig(configPath)).rejects.toThrow('MISSING_VAR');
  });

  it('parses oauth.clientName and oauth.clientUri with ${VAR} expansion', async () => {
    process.env.TEST_CLIENT_NAME = 'My Approved Client';
    process.env.TEST_CLIENT_URI = 'https://example.com/app';
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        figma: {
          type: 'http',
          url: 'https://mcp.figma.com/mcp',
          description: 'Figma MCP',
          oauth: {
            clientName: '${TEST_CLIENT_NAME}',
            clientUri: '${TEST_CLIENT_URI}',
            scope: 'mcp:connect',
          },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    const servers = await loadConfig(configPath);
    expect(servers[0].oauth).toEqual({
      clientName: 'My Approved Client',
      clientUri: 'https://example.com/app',
      scope: 'mcp:connect',
    });
    delete process.env.TEST_CLIENT_NAME;
    delete process.env.TEST_CLIENT_URI;
  });

  it('trims oauth.clientName', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        figma: {
          type: 'http',
          url: 'https://mcp.figma.com/mcp',
          description: 'Figma MCP',
          oauth: { clientName: '  Padded Client  ' },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    const servers = await loadConfig(configPath);
    expect(servers[0].oauth?.clientName).toBe('Padded Client');
  });

  it('trims oauth.clientUri', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        figma: {
          type: 'http',
          url: 'https://mcp.figma.com/mcp',
          description: 'Figma MCP',
          oauth: { clientUri: '  https://example.com/app  ' },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    const servers = await loadConfig(configPath);
    expect(servers[0].oauth?.clientUri).toBe('https://example.com/app');
  });

  it('rejects an empty oauth.clientName with the server and field in the message', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        figma: {
          type: 'http',
          url: 'https://mcp.figma.com/mcp',
          description: 'Figma MCP',
          oauth: { clientName: '   ' },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    await expect(loadConfig(configPath)).rejects.toThrow(/Server "figma" oauth\.clientName/);
  });

  it('rejects a non-absolute oauth.clientUri with the server and field in the message', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        figma: {
          type: 'http',
          url: 'https://mcp.figma.com/mcp',
          description: 'Figma MCP',
          oauth: { clientUri: 'not-a-url' },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    await expect(loadConfig(configPath)).rejects.toThrow(/Server "figma" oauth\.clientUri/);
  });

  it('allows oauth block with only clientId (public client)', async () => {
    process.env.CLIENT_ID = 'pub-client';
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        github: {
          type: 'http',
          url: 'https://api.github.com/mcp',
          description: 'GitHub API tools',
          oauth: { clientId: '${CLIENT_ID}' },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    const servers = await loadConfig(configPath);
    expect(servers[0].oauth).toEqual({ clientId: 'pub-client' });
    delete process.env.CLIENT_ID;
  });

  it('parses oauth.callbackPort as a number', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        github: {
          type: 'http',
          url: 'https://api.github.com/mcp',
          description: 'GitHub API tools',
          oauth: { clientId: 'cid', callbackPort: 8765 },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    const servers = await loadConfig(configPath);
    expect(servers[0].oauth?.callbackPort).toBe(8765);
  });

  it('parses oauth.callbackPort from a numeric string', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        github: {
          type: 'http',
          url: 'https://api.github.com/mcp',
          description: 'GitHub API tools',
          oauth: { callbackPort: '8765' },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    const servers = await loadConfig(configPath);
    expect(servers[0].oauth?.callbackPort).toBe(8765);
  });

  it('rejects oauth.callbackPort outside the valid range', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        github: {
          type: 'http',
          url: 'https://api.github.com/mcp',
          description: 'GitHub API tools',
          oauth: { callbackPort: 70000 },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    await expect(loadConfig(configPath)).rejects.toThrow(/callbackPort/i);
  });

  it('rejects a non-integer oauth.callbackPort', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        github: {
          type: 'http',
          url: 'https://api.github.com/mcp',
          description: 'GitHub API tools',
          oauth: { callbackPort: 'not-a-port' },
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    await expect(loadConfig(configPath)).rejects.toThrow(/callbackPort/i);
  });
});
