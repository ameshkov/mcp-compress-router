import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { routerPath, resolveFixtureCommand } from './helpers.js';
import { McpTestClient } from './client.js';

/** Extracts the get_tool_schema description from a tools/list response. */
async function getCatalogDescription(client: McpTestClient): Promise<string> {
  const resp = await client.sendRequest('tools/list');
  const tools = (
    resp.result as {
      tools: Array<{ name: string; description?: string }>;
    }
  ).tools;
  return tools.find((t) => t.name === 'get_tool_schema')!.description ?? '';
}

describe('MCP Compress Router E2E — compact catalog', () => {
  let client: McpTestClient | undefined;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `mcp-e2e-compact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function startRouter(includeDescription = true): Promise<McpTestClient> {
    const fixture = await resolveFixtureCommand();
    const entry: Record<string, unknown> = {
      type: 'stdio',
      command: fixture.command,
      args: fixture.args,
    };
    if (includeDescription) {
      entry.description = 'A test fixture server';
    }
    const config = {
      mcpServers: { fixture: entry },
    };
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    client = new McpTestClient();
    await client.start('node', [routerPath, '--config', configPath], {
      MCP_COMPRESS_ROUTER_HOME: tempDir,
    });
    return client;
  }

  it('renders a bullet with the tool count instead of tool names', async () => {
    const c = await startRouter();
    const description = await getCatalogDescription(c);

    expect(description).toContain('- fixture (6 tools) - A test fixture server');
    expect(description).toContain(
      'Call get_tool_schema with the server name to list all tools, i.e. get_tool_schema(fixture)',
    );
    expect(description).not.toContain('echo');
    expect(description).not.toContain('add');
    expect(description).not.toContain('Available tools:');
  });

  it('starts without a server description and omits it from the catalog', async () => {
    const c = await startRouter(false);
    const description = await getCatalogDescription(c);

    expect(description).toContain('- fixture (6 tools)');
    expect(description).not.toContain('A test fixture server');
  });

  it('still allows listing the server tools without schemas', async () => {
    const c = await startRouter();
    const resp = await c.sendRequest('tools/call', {
      name: 'get_tool_schema',
      arguments: { server: 'fixture' },
    });
    const text = (resp.result as { content: Array<{ text: string }> }).content[0].text;

    expect(text).toContain('Tools provided by "fixture" (6):');
    expect(text).toContain('echo(message)');
    expect(text).toContain('add(a, b)');
  });

  it('returns the complete tool description in the schema result', async () => {
    const c = await startRouter();
    const resp = await c.sendRequest('tools/call', {
      name: 'get_tool_schema',
      arguments: { server: 'fixture', tools: ['echo'] },
    });
    const text = (resp.result as { content: Array<{ text: string }> }).content[0].text;
    const schemas = JSON.parse(text) as Array<{ name: string; description?: string }>;

    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe('echo');
    expect(schemas[0].description).toBeTruthy();
  });
});
