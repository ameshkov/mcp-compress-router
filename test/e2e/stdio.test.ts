import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { routerPath, resolveFixtureCommand } from './helpers.js';
import { McpTestClient } from './client.js';

describe('MCP Compress Router E2E — stdio', () => {
  let client: McpTestClient;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `mcp-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });

    const fixture = await resolveFixtureCommand();

    const config = {
      mcpServers: {
        fixture: {
          type: 'stdio',
          command: fixture.command,
          args: fixture.args,
          description: 'A test fixture server',
          env: { MCP_E2E_PROPAGATED: 'reached-the-child' },
        },
      },
    };

    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    client = new McpTestClient();
    await client.start('node', [routerPath, '--config', configPath], {
      MCP_COMPRESS_ROUTER_HOME: tempDir,
    });
  });

  afterEach(async () => {
    await client.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('exposes exactly get_tool_schema and invoke_tool', async () => {
    const resp = await client.sendRequest('tools/list');
    expect(resp.error).toBeUndefined();

    const tools = (resp.result as { tools: Array<{ name: string }> }).tools;
    expect(tools).toHaveLength(2);

    const toolNames = tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(['get_tool_schema', 'invoke_tool']);
  });

  it('get_tool_schema description contains server name and tool names', async () => {
    const resp = await client.sendRequest('tools/list');
    const tools = (
      resp.result as {
        tools: Array<{ name: string; description?: string }>;
      }
    ).tools;
    const gts = tools.find((t) => t.name === 'get_tool_schema')!;
    expect(gts.description).toContain('fixture');
    expect(gts.description).toContain('echo');
    expect(gts.description).toContain('add');
    expect(gts.description).toContain('A test fixture server');
  });

  it('get_tool_schema returns schema for a known tool', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'get_tool_schema',
      arguments: {
        server: 'fixture',
        tools: ['echo'],
      },
    });

    expect(resp.error).toBeUndefined();

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
    };
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe('echo');
    expect(parsed[0].description).toBe('Returns the input message unchanged.');
    expect(parsed[0].inputSchema).toHaveProperty('properties');
  });

  it('get_tool_schema returns error for unknown server', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'get_tool_schema',
      arguments: {
        server: 'nonexistent',
        tools: ['echo'],
      },
    });

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent');
    expect(result.content[0].text).toContain('fixture');
  });

  it('invoke_tool returns error for unknown server listing valid servers', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'nonexistent',
        tool: 'echo',
        arguments: { message: 'hi' },
      },
    });

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent');
    expect(result.content[0].text).toContain('Available servers');
    expect(result.content[0].text).toContain('fixture');
  });

  it('get_tool_schema returns error for unknown tool listing valid tools', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'get_tool_schema',
      arguments: {
        server: 'fixture',
        tools: ['nonexistent_tool'],
      },
    });

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent_tool');
    expect(result.content[0].text).toContain('Valid tools');
    expect(result.content[0].text).toContain('echo');
    expect(result.content[0].text).toContain('add');
  });

  it('invoke_tool returns error for unknown tool listing valid tools', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'fixture',
        tool: 'nonexistent_tool',
        arguments: {},
      },
    });

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent_tool');
    expect(result.content[0].text).toContain('Valid tools');
    expect(result.content[0].text).toContain('echo');
  });

  it('get_tool_schema errors on partial failure — one known, one unknown', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'get_tool_schema',
      arguments: {
        server: 'fixture',
        tools: ['echo', 'nonexistent_tool'],
      },
    });

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent_tool');
    expect(result.content[0].text).toContain('Valid tools');
    // The result is an error, NOT a partial result with just 'echo'
  });

  it('invoke_tool returns error for missing required argument', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'fixture',
        tool: 'echo',
        arguments: {},
      },
    });

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing required argument');
    expect(result.content[0].text).toContain('"message"');
    expect(result.content[0].text).toContain('Expected shape');
  });

  it('invoke_tool returns error for wrong argument type', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'fixture',
        tool: 'add',
        arguments: { a: 'not-a-number', b: 3 },
      },
    });

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Wrong type');
    expect(result.content[0].text).toContain('"a"');
    expect(result.content[0].text).toContain('expected number');
    expect(result.content[0].text).toContain('Expected shape');
  });

  it('invoke_tool returns error for unknown argument', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'fixture',
        tool: 'echo',
        arguments: { message: 'hi', extra_field: 'nope' },
      },
    });

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown argument');
    expect(result.content[0].text).toContain('"extra_field"');
    expect(result.content[0].text).toContain('Expected shape');
  });

  it('invoke_tool forwards echo and returns result verbatim', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'fixture',
        tool: 'echo',
        arguments: { message: 'hello from e2e' },
      },
    });

    expect(resp.error).toBeUndefined();

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'hello from e2e',
    });
  });

  it('stdio env field propagates to the downstream child process', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'fixture',
        tool: 'echo_env',
        arguments: { name: 'MCP_E2E_PROPAGATED' },
      },
    });

    expect(resp.error).toBeUndefined();

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'reached-the-child',
    });
  });

  it('invoke_tool forwards add with numbers', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'fixture',
        tool: 'add',
        arguments: { a: 7, b: 3 },
      },
    });

    expect(resp.error).toBeUndefined();

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: '10',
    });
  });

  it('invoke_tool passes multi-block content through unchanged', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'fixture',
        tool: 'multi_block',
        arguments: { prefix: 'hello' },
      },
    });

    expect(resp.error).toBeUndefined();

    const result = resp.result as {
      content: Array<{ type: string; text?: string; resource?: unknown }>;
    };
    expect(result.content).toHaveLength(3);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'hello: first block',
    });
    expect(result.content[1]).toEqual({
      type: 'resource',
      resource: {
        uri: 'test://fixture/block-2',
        text: 'second block as resource',
      },
    });
    expect(result.content[2]).toEqual({ type: 'text', text: 'third block' });
  });

  it('invoke_tool routes to correct server when two servers share a tool name', async () => {
    // Set up a second fixture server with the same 'echo' tool
    const secondFixture = await resolveFixtureCommand();

    const config = {
      mcpServers: {
        fixture_a: {
          type: 'stdio',
          command: secondFixture.command,
          args: secondFixture.args,
          description: 'First fixture',
        },
        fixture_b: {
          type: 'stdio',
          command: secondFixture.command,
          args: secondFixture.args,
          description: 'Second fixture',
        },
      },
    };

    const secondTempDir = path.join(
      tmpdir(),
      `mcp-e2e-2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(secondTempDir, { recursive: true });

    const configPath = path.join(secondTempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    const secondClient = new McpTestClient();
    try {
      await secondClient.start('node', [routerPath, '--config', configPath], {
        MCP_COMPRESS_ROUTER_HOME: secondTempDir,
      });

      // Call echo on fixture_b
      const resp = await secondClient.sendRequest('tools/call', {
        name: 'invoke_tool',
        arguments: {
          server: 'fixture_b',
          tool: 'echo',
          arguments: { message: 'from b' },
        },
      });

      expect(resp.error).toBeUndefined();
      const result = resp.result as {
        content: Array<{ type: string; text: string }>;
      };
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'from b',
      });
    } finally {
      await secondClient.close();
      await fs.rm(secondTempDir, { recursive: true, force: true });
    }
  });

  it('survives a downstream server crash and healthy server still works', async () => {
    // Arrange: build config with two fixture servers
    const fixture = await resolveFixtureCommand();

    const config = {
      mcpServers: {
        'fixture-a': {
          type: 'stdio',
          command: fixture.command,
          args: [...fixture.args],
          description: 'Fixture server A',
        },
        'fixture-b': {
          type: 'stdio',
          command: fixture.command,
          args: [...fixture.args],
          description: 'Fixture server B',
        },
      },
    };

    const multiTempDir = path.join(
      tmpdir(),
      `mcp-e2e-resilience-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(multiTempDir, { recursive: true });

    const configPath = path.join(multiTempDir, 'mcp-multi.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    // Start a fresh router with two servers
    const multiClient = new McpTestClient();
    await multiClient.start('node', [routerPath, '--config', configPath], {
      MCP_COMPRESS_ROUTER_HOME: multiTempDir,
    });

    try {
      // Sanity: healthy server works
      const healthyResp = await multiClient.sendRequest('tools/call', {
        name: 'invoke_tool',
        arguments: {
          server: 'fixture-b',
          tool: 'echo',
          arguments: { message: 'healthy before crash' },
        },
      });

      expect(healthyResp.error).toBeUndefined();
      const healthyResult = healthyResp.result as {
        content: Array<{ type: string; text: string }>;
      };
      expect(healthyResult.content[0].text).toBe('healthy before crash');

      // Act: crash fixture-a
      const crashResp = await multiClient.sendRequest('tools/call', {
        name: 'invoke_tool',
        arguments: {
          server: 'fixture-a',
          tool: 'crash',
          arguments: {},
        },
      });

      // Assert: error is surfaced as result, not protocol error
      const crashResult = crashResp.result as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      expect(crashResult.isError).toBe(true);

      // Assert: router is still alive
      expect(multiClient.isAlive()).toBe(true);

      // Assert: healthy server still works
      const postCrashResp = await multiClient.sendRequest('tools/call', {
        name: 'invoke_tool',
        arguments: {
          server: 'fixture-b',
          tool: 'echo',
          arguments: { message: 'healthy after crash' },
        },
      });

      expect(postCrashResp.error).toBeUndefined();
      const postCrashResult = postCrashResp.result as {
        content: Array<{ type: string; text: string }>;
      };
      expect(postCrashResult.content[0].text).toBe('healthy after crash');
    } finally {
      await multiClient.close();
      await fs.rm(multiTempDir, { recursive: true, force: true });
    }
  }, 15000);

  it('excludes a disabled server from the catalog and rejects invoke_tool on it', async () => {
    const fixture = await resolveFixtureCommand();

    const config = {
      mcpServers: {
        on: {
          type: 'stdio',
          command: fixture.command,
          args: fixture.args,
          description: 'Enabled fixture',
        },
        off: {
          type: 'stdio',
          command: fixture.command,
          args: fixture.args,
          description: 'Disabled fixture',
          enabled: false,
        },
      },
    };

    const disabledTempDir = path.join(
      tmpdir(),
      `mcp-e2e-disabled-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(disabledTempDir, { recursive: true });

    const configPath = path.join(disabledTempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    const disabledClient = new McpTestClient();
    try {
      await disabledClient.start('node', [routerPath, '--config', configPath], {
        MCP_COMPRESS_ROUTER_HOME: disabledTempDir,
      });

      // The compact catalog inside get_tool_schema's description must
      // list the enabled server and its tools, but NOT the disabled one.
      const listResp = await disabledClient.sendRequest('tools/list');
      const tools = (
        listResp.result as {
          tools: Array<{ name: string; description?: string }>;
        }
      ).tools;
      const gts = tools.find((t) => t.name === 'get_tool_schema')!;
      expect(gts.description).toContain('on');
      expect(gts.description).toContain('echo');
      expect(gts.description).not.toContain('off');
      expect(gts.description).not.toContain('Disabled fixture');

      // get_tool_schema on the disabled server fails and names it.
      const schemaResp = await disabledClient.sendRequest('tools/call', {
        name: 'get_tool_schema',
        arguments: { server: 'off', tools: ['echo'] },
      });
      const schemaResult = schemaResp.result as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      expect(schemaResult.isError).toBe(true);
      expect(schemaResult.content[0].text).toContain('off');

      // invoke_tool on the disabled server fails and names it, without
      // forwarding to the downstream process.
      const invokeResp = await disabledClient.sendRequest('tools/call', {
        name: 'invoke_tool',
        arguments: {
          server: 'off',
          tool: 'echo',
          arguments: { message: 'should not reach downstream' },
        },
      });
      const invokeResult = invokeResp.result as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      expect(invokeResult.isError).toBe(true);
      expect(invokeResult.content[0].text).toContain('off');
      expect(invokeResult.content[0].text).toContain('Available servers');
      expect(invokeResult.content[0].text).toContain('on');

      // The enabled server still works end-to-end.
      const okResp = await disabledClient.sendRequest('tools/call', {
        name: 'invoke_tool',
        arguments: {
          server: 'on',
          tool: 'echo',
          arguments: { message: 'still up' },
        },
      });
      expect(okResp.error).toBeUndefined();
      const okResult = okResp.result as {
        content: Array<{ type: string; text: string }>;
      };
      expect(okResult.content[0]).toEqual({ type: 'text', text: 'still up' });
    } finally {
      await disabledClient.close();
      await fs.rm(disabledTempDir, { recursive: true, force: true });
    }
  }, 15000);

  it('emits structured info-level logs to stderr on startup and invocation', async () => {
    const stderr = client.getStderr();

    // Should have startup messages at info level
    expect(stderr).toContain('"level":"info"');

    // Should NOT have debug messages by default
    expect(stderr).not.toContain('"level":"debug"');

    // Parse the stderr to verify structured format
    const lines = stderr
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));

    expect(lines.length).toBeGreaterThan(0);

    // All lines should have timestamp, level, message
    for (const line of lines) {
      expect(line).toHaveProperty('timestamp');
      expect(line).toHaveProperty('level');
      expect(line).toHaveProperty('message');
    }

    // There should be at least a "Server started" message
    const startedMsg = lines.find((l) => l.message.includes('Server started'));
    expect(startedMsg).toBeDefined();
    expect(startedMsg.level).toBe('info');
  });

  it('emits debug-level logs when started with --verbose', async () => {
    const verboseClient = new McpTestClient();
    try {
      const fixture = await resolveFixtureCommand();

      const config = {
        mcpServers: {
          fixture: {
            type: 'stdio',
            command: fixture.command,
            args: fixture.args,
          },
        },
      };

      const verboseTempDir = path.join(
        tmpdir(),
        `mcp-e2e-verbose-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      await fs.mkdir(verboseTempDir, { recursive: true });

      const configPath = path.join(verboseTempDir, 'mcp.json');
      await fs.writeFile(configPath, JSON.stringify(config));

      await verboseClient.start('node', [routerPath, '--config', configPath, '--verbose'], {
        MCP_COMPRESS_ROUTER_HOME: verboseTempDir,
      });

      // Trigger a tool call to generate debug-level messages
      await verboseClient.sendRequest('tools/call', {
        name: 'invoke_tool',
        arguments: {
          server: 'fixture',
          tool: 'echo',
          arguments: { message: 'debug-test' },
        },
      });

      const stderr = verboseClient.getStderr();
      expect(stderr).toContain('"level":"debug"');

      // Should also still have info messages
      expect(stderr).toContain('"level":"info"');

      await verboseClient.close();
      await fs.rm(verboseTempDir, { recursive: true, force: true });
    } finally {
      await verboseClient.close();
    }
  }, 15000);
});
