import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfigDir, resolveConfigPath, loadConfig, defaultConfigDir } from './config.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { tmpdir } from 'node:os';

describe('resolveConfigDir', () => {
  const originalHome = process.env.MCP_COMPRESS_ROUTER_HOME;

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.MCP_COMPRESS_ROUTER_HOME = originalHome;
    } else {
      delete process.env.MCP_COMPRESS_ROUTER_HOME;
    }
  });

  it('returns the MCP_COMPRESS_ROUTER_HOME path when env var is set', () => {
    process.env.MCP_COMPRESS_ROUTER_HOME = '/custom/home';
    expect(resolveConfigDir()).toBe('/custom/home');
  });

  it('returns the platform-specific default path when env var is not set', () => {
    delete process.env.MCP_COMPRESS_ROUTER_HOME;
    expect(resolveConfigDir()).toBe(
      defaultConfigDir(process.platform, os.homedir(), process.env.APPDATA),
    );
  });
});

describe('defaultConfigDir', () => {
  // Expected bases are asserted via path.join so the cases stay portable
  // across the host's path separator (POSIX vs win32).
  it.each<[string, NodeJS.Platform, string, string | undefined, string]>([
    ['win32 with APPDATA', 'win32', 'C:/u', 'C:/u/AppData/Roaming', 'C:/u/AppData/Roaming'],
    ['win32 without APPDATA', 'win32', 'C:/u', undefined, 'C:/u/AppData/Roaming'],
    ['macOS', 'darwin', '/Users/user', undefined, '/Users/user/Library/Application Support'],
    ['Linux', 'linux', '/home/user', undefined, '/home/user/.local/share'],
    ['other Unix', 'freebsd', '/home/user', undefined, '/home/user/.local/share'],
  ])('resolves the correct directory for %s', (_name, platform, home, appData, expectedBase) => {
    expect(defaultConfigDir(platform, home, appData)).toBe(
      path.join(expectedBase, 'mcp-compress-router'),
    );
  });
});

describe('resolveConfigPath', () => {
  const originalHome = process.env.MCP_COMPRESS_ROUTER_HOME;
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(
      tmpdir(),
      `config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    if (originalHome !== undefined) {
      process.env.MCP_COMPRESS_ROUTER_HOME = originalHome;
    } else {
      delete process.env.MCP_COMPRESS_ROUTER_HOME;
    }
  });

  it('returns the explicit path when provided', async () => {
    await expect(resolveConfigPath('/explicit/mcp.json')).resolves.toBe('/explicit/mcp.json');
  });

  it('returns the MCP_COMPRESS_ROUTER_HOME path when env var is set and neither file exists', async () => {
    process.env.MCP_COMPRESS_ROUTER_HOME = tempDir;
    await expect(resolveConfigPath(undefined)).resolves.toBe(path.join(tempDir, 'mcp.json'));
  });

  it('returns the default home path when no arg or env var', async () => {
    delete process.env.MCP_COMPRESS_ROUTER_HOME;
    const expected = path.join(
      defaultConfigDir(process.platform, os.homedir(), process.env.APPDATA),
      'mcp.json',
    );
    await expect(resolveConfigPath(undefined)).resolves.toBe(expected);
  });

  it('prefers mcp.jsonc when both mcp.jsonc and mcp.json exist in the directory', async () => {
    process.env.MCP_COMPRESS_ROUTER_HOME = tempDir;
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, 'mcp.json'), '{}');
    await fs.writeFile(path.join(tempDir, 'mcp.jsonc'), '{}');
    await expect(resolveConfigPath(undefined)).resolves.toBe(path.join(tempDir, 'mcp.jsonc'));
  });

  it('falls back to mcp.json when only mcp.json exists', async () => {
    process.env.MCP_COMPRESS_ROUTER_HOME = tempDir;
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, 'mcp.json'), '{}');
    await expect(resolveConfigPath(undefined)).resolves.toBe(path.join(tempDir, 'mcp.json'));
  });

  it('returns mcp.json when neither mcp.jsonc nor mcp.json exists', async () => {
    process.env.MCP_COMPRESS_ROUTER_HOME = tempDir;
    await fs.mkdir(tempDir, { recursive: true });
    await expect(resolveConfigPath(undefined)).resolves.toBe(path.join(tempDir, 'mcp.json'));
  });
});

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
  });
});
