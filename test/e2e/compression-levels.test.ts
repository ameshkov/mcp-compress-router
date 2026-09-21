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

describe('MCP Compress Router E2E — compression levels', () => {
  let client: McpTestClient | undefined;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `mcp-e2e-compress-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function startRouter(compressionLevel?: string): Promise<McpTestClient> {
    const fixture = await resolveFixtureCommand();
    const config = {
      mcpServers: {
        fixture: {
          type: 'stdio',
          command: fixture.command,
          args: fixture.args,
          description: 'A test fixture server',
          ...(compressionLevel === undefined ? {} : { compressionLevel }),
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

  it('max renders the tool count and pointer instead of tool names', async () => {
    const c = await startRouter('max');
    const description = await getCatalogDescription(c);

    expect(description).toContain('Provides 6 tools');
    expect(description).toContain('Call get_tool_schema with "fixture" to list them.');
    expect(description).not.toContain('echo');
    expect(description).not.toContain('add');
    expect(description).not.toContain('Available tools:');
  });

  it('max still allows listing the server tools without schemas', async () => {
    const c = await startRouter('max');
    const resp = await c.sendRequest('tools/call', {
      name: 'get_tool_schema',
      arguments: { server: 'fixture' },
    });
    const text = (resp.result as { content: Array<{ text: string }> }).content[0].text;

    expect(text).toContain('Tools provided by "fixture" (6):');
    expect(text).toContain('echo(message)');
    expect(text).toContain('add(a, b)');
  });

  it('medium renders signatures without descriptions', async () => {
    const c = await startRouter('medium');
    const description = await getCatalogDescription(c);

    expect(description).toContain('echo(message)');
    expect(description).toContain('add(a, b)');
    expect(description).not.toContain('Returns the input message');
    expect(description).not.toContain('Adds two numbers');
  });

  it('low renders signatures with the first sentence of the description', async () => {
    const c = await startRouter('low');
    const description = await getCatalogDescription(c);

    expect(description).toContain('echo(message): Returns the input message unchanged');
    expect(description).not.toContain('<tool>');
  });

  it('high is the default and renders names only', async () => {
    const c = await startRouter();
    const description = await getCatalogDescription(c);

    expect(description).toContain('echo, add, multi_block, failing_tool, crash, echo_env');
    expect(description).not.toContain('echo(message)');
    expect(description).not.toContain('Provides');
  });
});
