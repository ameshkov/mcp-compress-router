import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

describe('loadConfig', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('loads stdio servers from mcpServers', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        server1: {
          type: 'stdio',
          command: 'node',
          args: ['./server1.js'],
        },
        server2: {
          type: 'stdio',
          command: '/usr/bin/python3',
          args: ['-m', 'my_mcp'],
          env: { FOO: 'bar' },
          description: 'A Python MCP server',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const servers = await loadConfig(configPath);
    expect(servers).toHaveLength(2);
    expect(servers[0]).toEqual({
      name: 'server1',
      type: 'stdio',
      command: 'node',
      args: ['./server1.js'],
      env: undefined,
      url: undefined,
      headers: undefined,
      description: undefined,
      enabled: undefined,
      allowedTools: undefined,
      disabledTools: undefined,
    });
    expect(servers[1]).toEqual({
      name: 'server2',
      type: 'stdio',
      command: '/usr/bin/python3',
      args: ['-m', 'my_mcp'],
      env: { FOO: 'bar' },
      url: undefined,
      headers: undefined,
      description: 'A Python MCP server',
      enabled: undefined,
      allowedTools: undefined,
      disabledTools: undefined,
    });
  });

  it('loads servers from a JSONC file with comments and trailing commas', async () => {
    const configPath = path.join(tempDir, 'mcp.jsonc');
    const config = `{
      // Comment: server config
      "mcpServers": {
        "alpha": {
          "type": "stdio",
          "command": "node",
          "args": ["./alpha.js",],
          "description": "Alpha server",
        },
        /* block comment */
        "beta": {
          "type": "http",
          "url": "https://beta.example.com/mcp",
          "headers": {"Authorization": "Bearer token",},
        },
      },
    }`;
    await fs.writeFile(configPath, config);

    const servers = await loadConfig(configPath);
    expect(servers).toHaveLength(2);
    expect(servers[0]).toMatchObject({ name: 'alpha', type: 'stdio', command: 'node' });
    expect(servers[1]).toMatchObject({
      name: 'beta',
      type: 'http',
      url: 'https://beta.example.com/mcp',
    });
  });

  it('rejects config with missing command field', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        bad: { type: 'stdio' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    await expect(loadConfig(configPath)).rejects.toThrow(/command/);
  });

  it('rejects config with missing type field', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        bad: { command: 'node' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    await expect(loadConfig(configPath)).rejects.toThrow(/missing required "type"/);
  });

  it('rejects http server missing url field', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        bad: { type: 'http' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    await expect(loadConfig(configPath)).rejects.toThrow(/"url"/);
  });

  it('accepts valid http server entry', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        api: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer token' },
          description: 'An HTTP MCP',
        },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    const servers = await loadConfig(configPath);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: 'api',
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      description: 'An HTTP MCP',
    });
  });

  it('rejects streamable-http server missing url field', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        bad: { type: 'streamable-http' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    await expect(loadConfig(configPath)).rejects.toThrow(/"url"/);
  });

  it('rejects empty command for stdio server', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        bad: { type: 'stdio', command: '' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    await expect(loadConfig(configPath)).rejects.toThrow(/missing required "command"/);
  });

  it('rejects unknown transport type', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        bad: { type: 'sse', url: 'https://example.com' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    await expect(loadConfig(configPath)).rejects.toThrow(/unsupported type/);
  });

  it('rejects unsupported transport type "ws" (WebSocket)', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        wsSrv: { type: 'ws', url: 'wss://example.com/mcp' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    await expect(loadConfig(configPath)).rejects.toThrow(/unsupported type "ws"/);
  });

  it('rejects unsupported transport type "sse" (server-sent events)', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = {
      mcpServers: {
        sseSrv: { type: 'sse', url: 'https://example.com/sse' },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));

    await expect(loadConfig(configPath)).rejects.toThrow(/unsupported type "sse"/);
  });

  it('rejects an empty mcpServers object (zero servers)', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    const config = { mcpServers: {} };
    await fs.writeFile(configPath, JSON.stringify(config));

    await expect(loadConfig(configPath)).rejects.toThrow(/no downstream MCP servers/);
  });

  describe('environment variable expansion', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      delete process.env.TEST_CMD;
      delete process.env.TEST_ARG;
      delete process.env.TEST_ENV;
      delete process.env.API_TOKEN;
      delete process.env.BASE_URL;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('expands ${VAR} in command field', async () => {
      process.env.TEST_CMD = '/usr/local/bin/node';
      const configPath = path.join(tempDir, 'mcp.json');
      const config = {
        mcpServers: {
          srv: { type: 'stdio', command: '${TEST_CMD}' },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));

      const servers = await loadConfig(configPath);
      expect(servers[0].command).toBe('/usr/local/bin/node');
    });

    it('expands ${VAR:-default} when var is unset', async () => {
      const configPath = path.join(tempDir, 'mcp.json');
      const config = {
        mcpServers: {
          srv: { type: 'stdio', command: '${TEST_CMD:-/usr/bin/node}' },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));

      const servers = await loadConfig(configPath);
      expect(servers[0].command).toBe('/usr/bin/node');
    });

    it('expands ${VAR:-default} when var is set', async () => {
      process.env.TEST_CMD = '/custom/node';
      const configPath = path.join(tempDir, 'mcp.json');
      const config = {
        mcpServers: {
          srv: { type: 'stdio', command: '${TEST_CMD:-/fallback}' },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));

      const servers = await loadConfig(configPath);
      expect(servers[0].command).toBe('/custom/node');
    });

    it('expands references in args array', async () => {
      process.env.TEST_ARG = '--verbose';
      const configPath = path.join(tempDir, 'mcp.json');
      const config = {
        mcpServers: {
          srv: { type: 'stdio', command: 'node', args: ['${TEST_ARG}', '--port', '${PORT:-3000}'] },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));

      const servers = await loadConfig(configPath);
      expect(servers[0].args).toEqual(['--verbose', '--port', '3000']);
    });

    it('expands references in env values', async () => {
      process.env.TEST_ENV = 'production';
      const configPath = path.join(tempDir, 'mcp.json');
      const config = {
        mcpServers: {
          srv: {
            type: 'stdio',
            command: 'node',
            env: { NODE_ENV: '${TEST_ENV}', LOG_LEVEL: '${LOG_LEVEL:-info}' },
          },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));

      const servers = await loadConfig(configPath);
      expect(servers[0].env).toEqual({ NODE_ENV: 'production', LOG_LEVEL: 'info' });
    });

    it('expands references in url field', async () => {
      process.env.BASE_URL = 'https://mcp.example.com';
      const configPath = path.join(tempDir, 'mcp.json');
      const config = {
        mcpServers: {
          api: { type: 'http', url: '${BASE_URL:-https://default.com}/v1' },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));

      const servers = await loadConfig(configPath);
      expect(servers[0].url).toBe('https://mcp.example.com/v1');
    });

    it('expands references in headers', async () => {
      process.env.API_TOKEN = 'secret123';
      const configPath = path.join(tempDir, 'mcp.json');
      const config = {
        mcpServers: {
          api: {
            type: 'http',
            url: 'https://example.com',
            headers: { Authorization: 'Bearer ${API_TOKEN}', 'X-Default': '${MISSING:-none}' },
          },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));

      const servers = await loadConfig(configPath);
      expect(servers[0].headers).toEqual({
        Authorization: 'Bearer secret123',
        'X-Default': 'none',
      });
    });

    it('rejects unresolved ${VAR} with no default in command', async () => {
      const configPath = path.join(tempDir, 'mcp.json');
      const config = {
        mcpServers: {
          srv: { type: 'stdio', command: '${UNDEFINED_VAR}' },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));

      await expect(loadConfig(configPath)).rejects.toThrow(/UNDEFINED_VAR/);
    });

    it('rejects unresolved ${VAR} in args', async () => {
      const configPath = path.join(tempDir, 'mcp.json');
      const config = {
        mcpServers: {
          srv: { type: 'stdio', command: 'node', args: ['${UNDEFINED_VAR}'] },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));

      await expect(loadConfig(configPath)).rejects.toThrow(/UNDEFINED_VAR/);
    });

    it('rejects unresolved ${VAR} in env values', async () => {
      const configPath = path.join(tempDir, 'mcp.json');
      const config = {
        mcpServers: {
          srv: { type: 'stdio', command: 'node', env: { KEY: '${UNDEFINED_VAR}' } },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));

      await expect(loadConfig(configPath)).rejects.toThrow(/UNDEFINED_VAR/);
    });

    it('rejects unresolved ${VAR} in url', async () => {
      const configPath = path.join(tempDir, 'mcp.json');
      const config = {
        mcpServers: {
          api: { type: 'http', url: '${UNDEFINED_VAR}/path' },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));

      await expect(loadConfig(configPath)).rejects.toThrow(/UNDEFINED_VAR/);
    });

    it('rejects unresolved ${VAR} in headers', async () => {
      const configPath = path.join(tempDir, 'mcp.json');
      const config = {
        mcpServers: {
          api: {
            type: 'http',
            url: 'https://example.com',
            headers: { Authorization: 'Bearer ${UNDEFINED_VAR}' },
          },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));

      await expect(loadConfig(configPath)).rejects.toThrow(/UNDEFINED_VAR/);
    });
  });

  describe('oauth block', () => {
    it('parses oauth block with ${VAR} expansion', async () => {
      process.env.TEST_CLIENT_ID = 'my-client';
      process.env.TEST_CLIENT_SECRET = 'my-secret';
      const configPath = path.join(tempDir, 'mcp.json');
      const config = {
        mcpServers: {
          github: {
            type: 'http',
            url: 'https://api.github.com/mcp',
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
            oauth: { clientId: '${MISSING_VAR}' },
          },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));
      await expect(loadConfig(configPath)).rejects.toThrow('MISSING_VAR');
    });

    it('allows oauth block with only clientId (public client)', async () => {
      process.env.CLIENT_ID = 'pub-client';
      const configPath = path.join(tempDir, 'mcp.json');
      const config = {
        mcpServers: {
          github: {
            type: 'http',
            url: 'https://api.github.com/mcp',
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
            oauth: { callbackPort: 'not-a-port' },
          },
        },
      };
      await fs.writeFile(configPath, JSON.stringify(config));
      await expect(loadConfig(configPath)).rejects.toThrow(/callbackPort/i);
    });
  });
});
