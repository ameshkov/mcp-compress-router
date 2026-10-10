import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { routerPath, resolveFixtureCommand } from './helpers.js';
import { McpTestClient } from './client.js';

describe('MCP Compress Router E2E — execution timeout', () => {
  let client: McpTestClient;
  let tempDir: string;

  afterEach(async () => {
    await client?.close();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails a hanging tool call at the configured execution budget and keeps serving', async () => {
    const fixture = await resolveFixtureCommand();

    tempDir = path.join(
      tmpdir(),
      `mcp-e2e-execution-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });

    const config = {
      mcpServers: {
        fixture: {
          type: 'stdio',
          command: fixture.command,
          args: fixture.args,
          description: 'A test fixture server',
          timeout: { execution: 300 },
        },
      },
    };
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    client = new McpTestClient();
    await client.start('node', [routerPath, '--config', configPath], {
      MCP_COMPRESS_ROUTER_HOME: tempDir,
    });

    // The fixture's `hang` tool never settles, so the configured
    // execution budget is the only thing that can end this call. The
    // per-test timeout doubles as the regression guard: without the
    // configured budget the call would stall until the resolved 1 h
    // default (3 600 000 ms) instead of returning here; the SDK's 60 s
    // default would apply only if invokeTool passed no options at all.
    const hangResp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'fixture',
        tool: 'hang',
        arguments: {},
      },
    });
    expect(hangResp.error).toBeUndefined();
    const hangResult = hangResp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(hangResult.isError).toBe(true);
    expect(hangResult.content[0].text).toContain(
      'Tool "hang" on server "fixture" timed out after 300 ms (timeout.execution)',
    );

    // The timeout is non-recoverable, so the router stays responsive
    // on the same session and a normal call still succeeds.
    const echoResp = await client.sendRequest('tools/call', {
      name: 'invoke_tool',
      arguments: {
        server: 'fixture',
        tool: 'echo',
        arguments: { message: 'still serving' },
      },
    });
    expect(echoResp.error).toBeUndefined();
    const echoResult = echoResp.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(echoResult.content[0]).toEqual({ type: 'text', text: 'still serving' });
  }, 15_000);
});
