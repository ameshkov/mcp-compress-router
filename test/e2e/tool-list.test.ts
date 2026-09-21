import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { routerPath, resolveFixtureCommand } from './helpers.js';
import { McpTestClient } from './client.js';

/** The fixed list-mode hint (stable for tests and QA). */
const LIST_HINT =
  'Call get_tool_schema with a tool name to get its full description and parameter schema.';

interface ToolCallResult {
  text: string;
  isError?: boolean;
}

async function callGetToolSchema(
  client: McpTestClient,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const resp = await client.sendRequest('tools/call', {
    name: 'get_tool_schema',
    arguments: args,
  });
  const result = resp.result as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  return { text: result.content[0].text, isError: result.isError };
}

describe('MCP Compress Router E2E — get_tool_schema list mode', () => {
  let client: McpTestClient | undefined;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `mcp-e2e-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function startRouter(env: Record<string, string> = {}): Promise<McpTestClient> {
    const fixture = await resolveFixtureCommand();
    const config = {
      mcpServers: {
        fixture: {
          type: 'stdio',
          command: fixture.command,
          args: fixture.args,
          description: 'A test fixture server',
          env,
        },
      },
    };
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    client = new McpTestClient();
    await client.start('node', [routerPath, '--config', configPath], {
      MCP_COMPRESS_ROUTER_HOME: tempDir,
    });
    return client;
  }

  it('advertises the list mode in the tool description', async () => {
    const c = await startRouter();
    const resp = await c.sendRequest('tools/list');
    const gts = (
      resp.result as {
        tools: Array<{ name: string; description?: string }>;
      }
    ).tools.find((t) => t.name === 'get_tool_schema')!;

    expect(gts.description).toContain(
      "or omit the tool names to list a server's tools and their arguments",
    );
  });

  it('lists tool signatures and the hint when tools is omitted', async () => {
    const c = await startRouter();
    const { text, isError } = await callGetToolSchema(c, { server: 'fixture' });

    expect(isError).toBeUndefined();
    expect(text).toContain('Tools provided by "fixture" (6):');
    expect(text).toContain('echo(message)');
    expect(text).toContain('add(a, b)');
    expect(text).toContain('crash()');
    expect(text).toContain(LIST_HINT);
    expect(() => JSON.parse(text)).toThrow();
  });

  it('treats an empty tools array like an omitted one', async () => {
    const c = await startRouter();
    const omitted = await callGetToolSchema(c, { server: 'fixture' });
    const empty = await callGetToolSchema(c, { server: 'fixture', tools: [] });

    expect(empty.isError).toBeUndefined();
    expect(empty.text).toBe(omitted.text);
  });

  it('reports an unknown server in list mode', async () => {
    const c = await startRouter();
    const { text, isError } = await callGetToolSchema(c, { server: 'nonexistent' });

    expect(isError).toBe(true);
    expect(text).toContain('nonexistent');
    expect(text).toContain('fixture');
  });

  it('renders the dedicated message for a zero-tool server', async () => {
    const c = await startRouter({ FIXTURE_EMPTY_TOOLS: '1' });
    const { text, isError } = await callGetToolSchema(c, { server: 'fixture' });

    expect(isError).toBeUndefined();
    expect(text).toBe('Server "fixture" advertises no tools.');
  });
});
