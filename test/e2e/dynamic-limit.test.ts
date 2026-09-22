import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { routerPath, resolveFixtureCommand } from './helpers.js';
import { McpTestClient } from './client.js';

const MAX_SIZE_ENV = 'MCP_COMPRESS_ROUTER_DYNAMIC_LIMIT_MAX_SIZE';
const CLIENTS_ENV = 'MCP_COMPRESS_ROUTER_DYNAMIC_LIMIT_CLIENTS';

/** Client identity matching the default dynamic-limit list. */
const CLAUDE_CLIENT = { name: 'claude-code', version: '2.1.278' };

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

/**
 * Waits until the router's stderr contains `marker` and returns the
 * accumulated stderr. The log line is written before the `tools/list`
 * response, but its stderr `data` event can arrive after it.
 */
async function waitForStderr(
  client: McpTestClient,
  marker: string,
  timeoutMs = 5000,
): Promise<string> {
  const start = Date.now();
  while (!client.getStderr().includes(marker)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for "${marker}"\n${client.getStderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return client.getStderr();
}

describe('MCP Compress Router E2E — dynamic-limit auto-degradation', () => {
  let client: McpTestClient | undefined;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `mcp-e2e-dynamic-limit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  interface StartOptions {
    routerEnv?: Record<string, string>;
    extraTools?: number;
    clientInfo?: { name: string; version: string };
    description?: string;
  }

  async function startRouter(options: StartOptions = {}): Promise<McpTestClient> {
    const fixture = await resolveFixtureCommand();
    const config = {
      mcpServers: {
        fixture: {
          type: 'stdio',
          command: fixture.command,
          args: fixture.args,
          description: options.description ?? 'A test fixture server',
          env:
            options.extraTools === undefined
              ? {}
              : { FIXTURE_EXTRA_TOOLS: String(options.extraTools) },
        },
      },
    };
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    client = new McpTestClient();
    await client.start(
      'node',
      [routerPath, '--config', configPath],
      { MCP_COMPRESS_ROUTER_HOME: tempDir, ...options.routerEnv },
      options.clientInfo,
    );
    return client;
  }

  it('degrades the whole catalog to max for a length-limited client on overflow', async () => {
    const c = await startRouter({ extraTools: 200, clientInfo: CLAUDE_CLIENT });
    const description = await getCatalogDescription(c);

    expect(description).toContain('Provides 206 tools');
    expect(description).toContain('Call get_tool_schema with "fixture" to list them.');
    expect(description).not.toContain('bulk_tool_001');
    expect(description).not.toContain('Available tools:');
  });

  it('keeps the configured level for clients outside the dynamic-limit list', async () => {
    const c = await startRouter({ extraTools: 200 });
    const description = await getCatalogDescription(c);

    expect(description).toContain('bulk_tool_001');
    expect(description).toContain('echo, add, multi_block, failing_tool, crash, echo_env');
    expect(description).not.toContain('Provides');
  });

  it('does not degrade a length-limited client when the description fits', async () => {
    const c = await startRouter({ extraTools: 10, clientInfo: CLAUDE_CLIENT });
    const description = await getCatalogDescription(c);

    expect(description).toContain('bulk_tool_001');
    expect(description).not.toContain('Provides');
  });

  it('honors a custom client list', async () => {
    const routerEnv = { [CLIENTS_ENV]: 'other-client' };

    const claude = await startRouter({ extraTools: 200, routerEnv, clientInfo: CLAUDE_CLIENT });
    const claudeDescription = await getCatalogDescription(claude);
    expect(claudeDescription).toContain('bulk_tool_001');
    expect(claudeDescription).not.toContain('Provides');

    await claude.close();
    client = undefined;

    const other = await startRouter({
      extraTools: 200,
      routerEnv,
      clientInfo: { name: 'other-client', version: '1.0.0' },
    });
    const otherDescription = await getCatalogDescription(other);
    expect(otherDescription).toContain('Provides 206 tools');
    expect(otherDescription).not.toContain('bulk_tool_001');
  });

  it('honors a custom max size and falls back to the default for invalid values', async () => {
    const small = await startRouter({
      extraTools: 10,
      routerEnv: { [MAX_SIZE_ENV]: '100' },
      clientInfo: CLAUDE_CLIENT,
    });
    const smallDescription = await getCatalogDescription(small);
    expect(smallDescription).toContain('Provides 16 tools');
    expect(smallDescription).not.toContain('bulk_tool_001');

    await small.close();
    client = undefined;

    const invalid = await startRouter({
      extraTools: 10,
      routerEnv: { [MAX_SIZE_ENV]: 'not-a-number' },
      clientInfo: CLAUDE_CLIENT,
    });
    const invalidDescription = await getCatalogDescription(invalid);
    expect(invalidDescription).toContain('bulk_tool_001');
    expect(invalidDescription).not.toContain('Provides');
  });

  it('disables auto-degradation when the client list is empty', async () => {
    const c = await startRouter({
      extraTools: 200,
      routerEnv: { [CLIENTS_ENV]: '' },
      clientInfo: CLAUDE_CLIENT,
    });
    const description = await getCatalogDescription(c);

    expect(description).toContain('bulk_tool_001');
    expect(description).not.toContain('Provides');
  });

  it('warns when the degraded catalog still exceeds the cap', async () => {
    const c = await startRouter({
      extraTools: 200,
      clientInfo: CLAUDE_CLIENT,
      description: 'x'.repeat(2500),
    });
    const description = await getCatalogDescription(c);

    expect(description).toContain('Provides 206 tools');
    const stderr = await waitForStderr(c, 'still exceeds the description cap');
    expect(stderr).toContain('"level":"warn"');
  });
});
