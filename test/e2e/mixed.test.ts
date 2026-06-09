import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type * as http from 'node:http';
import { routerPath, resolveFixtureCommand, createHttpFixtureServer } from './helpers.js';
import { McpTestClient } from './client.js';

describe('MCP Compress Router E2E — mixed transports', () => {
  let client: McpTestClient;
  let tempDir: string;
  let httpServer: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const fixture = await createHttpFixtureServer();
    httpServer = fixture.server;
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('HTTP fixture server not listening');
    }
    baseUrl = `http://127.0.0.1:${addr.port}/mcp`;
  });

  afterAll(() => {
    httpServer.close();
  });

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `mcp-e2e-mixed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });

    const stdioFixture = await resolveFixtureCommand();

    const config = {
      mcpServers: {
        'stdio-fixture': {
          type: 'stdio',
          command: stdioFixture.command,
          args: stdioFixture.args,
          description: 'A stdio fixture server',
        },
        'http-fixture': {
          type: 'streamable-http',
          url: baseUrl,
          description: 'An HTTP fixture server',
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

  it('discovers tools from both stdio and HTTP servers', async () => {
    const resp = await client.sendRequest('tools/list');
    expect(resp.error).toBeUndefined();

    const tools = (
      resp.result as {
        tools: Array<{ name: string; description?: string }>;
      }
    ).tools;
    const gts = tools.find((t) => t.name === 'get_tool_schema')!;

    // Both servers appear in the catalog description
    expect(gts.description).toContain('stdio-fixture');
    expect(gts.description).toContain('http-fixture');
    // Tools from both servers are listed
    expect(gts.description).toContain('echo');
    expect(gts.description).toContain('add');
    expect(gts.description).toContain('check_auth');
  });

  it('invokes a tool on the stdio server', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'stdio-fixture',
        tool: 'echo',
        arguments: { message: 'from stdio' },
      },
    });

    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0].text).toBe('from stdio');
  });

  it('invokes a tool on the HTTP server', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'http-fixture',
        tool: 'echo',
        arguments: { message: 'from http' },
      },
    });

    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0].text).toBe('from http');
  });

  it('get_tool_schema returns schemas from both transports', async () => {
    // Schema from stdio server
    const stdioResp = await client.sendRequest('tools/call', {
      name: 'get_tool_schema',
      arguments: { server: 'stdio-fixture', tools: ['echo'] },
    });
    expect(stdioResp.error).toBeUndefined();
    const stdioText = (stdioResp.result as { content: Array<{ type: string; text: string }> })
      .content[0].text;
    const stdioParsed = JSON.parse(stdioText);
    expect(stdioParsed[0].name).toBe('echo');

    // Schema from HTTP server
    const httpResp = await client.sendRequest('tools/call', {
      name: 'get_tool_schema',
      arguments: { server: 'http-fixture', tools: ['check_auth'] },
    });
    expect(httpResp.error).toBeUndefined();
    const httpText = (httpResp.result as { content: Array<{ type: string; text: string }> })
      .content[0].text;
    const httpParsed = JSON.parse(httpText);
    expect(httpParsed[0].name).toBe('check_auth');
  });
});
