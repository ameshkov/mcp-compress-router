import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type * as http from 'node:http';
import { routerPath, createHttpFixtureServer } from './helpers.js';
import { McpTestClient } from './client.js';

describe('MCP Compress Router E2E — HTTP downstream', () => {
  let client: McpTestClient;
  let tempDir: string;
  let httpServer: http.Server;
  let getLastAuthHeader: () => string | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    const fixture = await createHttpFixtureServer();
    httpServer = fixture.server;
    getLastAuthHeader = fixture.getLastAuthHeader;
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
      `mcp-e2e-http-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });

    const config = {
      mcpServers: {
        'http-fixture': {
          type: 'streamable-http',
          url: baseUrl,
          headers: {
            Authorization: 'Bearer test-token-123',
            'X-Custom': 'custom-value',
          },
          description: 'An HTTP test fixture server',
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

  it('get_tool_schema description contains HTTP server and its tool names', async () => {
    const resp = await client.sendRequest('tools/list');
    const tools = (
      resp.result as {
        tools: Array<{ name: string; description?: string }>;
      }
    ).tools;
    const gts = tools.find((t) => t.name === 'get_tool_schema')!;
    expect(gts.description).toContain('http-fixture');
    expect(gts.description).toContain('echo');
    expect(gts.description).toContain('add');
    expect(gts.description).toContain('An HTTP test fixture server');
  });

  it('get_tool_schema returns schema for a tool on an HTTP server', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'get_tool_schema',
      arguments: {
        server: 'http-fixture',
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
  });

  it('invoke_tool forwards echo to HTTP server and returns result', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'http-fixture',
        tool: 'echo',
        arguments: { message: 'hello from http e2e' },
      },
    });

    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe('hello from http e2e');
  });

  it('invoke_tool forwards add to HTTP server and returns result', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'http-fixture',
        tool: 'add',
        arguments: { a: 7, b: 8 },
      },
    });

    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0].text).toBe('15');
  });

  it('invoke_tool returns error for unknown server on HTTP', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'nonexistent',
        tool: 'echo',
        arguments: {},
      },
    });

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent');
    expect(result.content[0].text).toContain('http-fixture');
  });

  it('invoke_tool passes through isError from HTTP server', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'http-fixture',
        tool: 'failing_tool',
        arguments: { message: 'deliberate failure' },
      },
    });

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('deliberate failure');
  });

  it('forwards configured headers to the HTTP downstream server', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'http-fixture',
        tool: 'check_auth',
        arguments: {},
      },
    });

    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0].text).toContain('Bearer test-token-123');
  });
});
