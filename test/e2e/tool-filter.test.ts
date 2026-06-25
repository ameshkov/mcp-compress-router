import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { routerPath, resolveFixtureCommand } from './helpers.js';
import { McpTestClient } from './client.js';

describe('MCP Compress Router E2E — tool filtering', () => {
  let client: McpTestClient;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `mcp-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await client.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('allowlist hides non-matching tools in the catalog description', async () => {
    const fixture = await resolveFixtureCommand();
    const config = {
      mcpServers: {
        fixture: {
          type: 'stdio',
          command: fixture.command,
          args: fixture.args,
          allowedTools: ['echo'],
        },
      },
    };
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    client = new McpTestClient();
    await client.start('node', [routerPath, '--config', configPath], {
      MCP_COMPRESS_ROUTER_HOME: tempDir,
    });

    const resp = await client.sendRequest('tools/list');
    const tools = (
      resp.result as {
        tools: Array<{ name: string; description?: string }>;
      }
    ).tools;
    const gts = tools.find((t) => t.name === 'get_tool_schema')!;

    expect(gts.description).toContain('echo');
    expect(gts.description).not.toContain('crash');
    expect(gts.description).not.toContain('add');
  });

  it('invoke_tool on a filtered tool errors locally without contacting downstream', async () => {
    const fixture = await resolveFixtureCommand();
    const config = {
      mcpServers: {
        fixture: {
          type: 'stdio',
          command: fixture.command,
          args: fixture.args,
          allowedTools: ['echo'],
        },
      },
    };
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    client = new McpTestClient();
    await client.start('node', [routerPath, '--config', configPath], {
      MCP_COMPRESS_ROUTER_HOME: tempDir,
    });

    // `crash` is filtered out. If it were forwarded, the fixture process
    // would exit(1) and the subsequent `echo` call would fail.
    const filteredResp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'fixture',
        tool: 'crash',
        arguments: {},
      },
    });

    const filteredResult = filteredResp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(filteredResult.isError).toBe(true);
    expect(filteredResult.content[0].text).toContain('crash');

    // Proof the fixture is still alive: a valid call still works.
    const echoResp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'fixture',
        tool: 'echo',
        arguments: { message: 'still-alive' },
      },
    });
    const echoResult = echoResp.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(echoResult.content[0].text).toBe('still-alive');
  });

  it('denylist hides the listed tool and blocks its invocation', async () => {
    const fixture = await resolveFixtureCommand();
    const config = {
      mcpServers: {
        fixture: {
          type: 'stdio',
          command: fixture.command,
          args: fixture.args,
          disabledTools: ['crash'],
        },
      },
    };
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    client = new McpTestClient();
    await client.start('node', [routerPath, '--config', configPath], {
      MCP_COMPRESS_ROUTER_HOME: tempDir,
    });

    const resp = await client.sendRequest('tools/list');
    const gts = (
      resp.result as {
        tools: Array<{ name: string; description?: string }>;
      }
    ).tools.find((t) => t.name === 'get_tool_schema')!;
    expect(gts.description).toContain('echo');
    expect(gts.description).not.toContain('crash');

    const blocked = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'fixture',
        tool: 'crash',
        arguments: {},
      },
    });
    const blockedResult = blocked.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(blockedResult.isError).toBe(true);
    expect(blockedResult.content[0].text).toContain('crash');
  });

  it('empty allowlist makes the server appear with zero tools', async () => {
    const fixture = await resolveFixtureCommand();
    const config = {
      mcpServers: {
        fixture: {
          type: 'stdio',
          command: fixture.command,
          args: fixture.args,
          allowedTools: [],
        },
      },
    };
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    client = new McpTestClient();
    await client.start('node', [routerPath, '--config', configPath], {
      MCP_COMPRESS_ROUTER_HOME: tempDir,
    });

    const resp = await client.sendRequest('tools/list');
    const gts = (
      resp.result as {
        tools: Array<{ name: string; description?: string }>;
      }
    ).tools.find((t) => t.name === 'get_tool_schema')!;
    expect(gts.description).toContain('## fixture');
    expect(gts.description).not.toContain('echo');
    expect(gts.description).not.toContain('add');
    expect(gts.description).not.toContain('crash');
  });
});
