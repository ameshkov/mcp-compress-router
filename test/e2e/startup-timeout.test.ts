import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { routerPath, resolveFixtureCommand } from './helpers.js';
import { McpTestClient } from './client.js';

/**
 * Starts an HTTP server that accepts every request but never responds,
 * simulating a downstream server that hangs its MCP endpoint AND its
 * OAuth well-known endpoints.
 */
function startHangingServer(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Intentionally never end the response.
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}/mcp` });
    });
  });
}

describe('MCP Compress Router E2E — startup with a hanging downstream server', () => {
  let client: McpTestClient;
  let tempDir: string;
  let hanging: http.Server;

  // 30s is the budget most MCP hosts allow for router startup. The
  // default timeouts and parallel startup phases must keep the router
  // well below it even when a downstream server times out.
  const STARTUP_BUDGET_MS = 30_000;
  // Keep the assertion comfortably below the budget so a regression
  // (e.g. sequential phases or an oversized default) fails loudly.
  const MAX_STARTUP_MS = 25_000;

  afterEach(async () => {
    await client.close();
    // Force-close the hung connections so the test process can exit.
    hanging?.closeAllConnections();
    await new Promise<void>((resolve) => hanging?.close(() => resolve()));
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it(
    'starts and serves within the 30s host budget even when one server hangs',
    async () => {
      const fixture = await resolveFixtureCommand();
      const hangingFixture = await startHangingServer();
      hanging = hangingFixture.server;

      tempDir = path.join(
        tmpdir(),
        `mcp-e2e-startup-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      await fs.mkdir(tempDir, { recursive: true });

      const config = {
        mcpServers: {
          'stdio-fixture': {
            type: 'stdio',
            command: fixture.command,
            args: fixture.args,
          },
          'hanging-http': {
            type: 'streamable-http',
            url: hangingFixture.url,
          },
        },
      };
      const configPath = path.join(tempDir, 'mcp.json');
      await fs.writeFile(configPath, JSON.stringify(config));

      // Seed the tool cache for the hanging server so the router degrades
      // gracefully instead of failing fast (no-cache cold start is fail-fast
      // by design).
      const cachedTool = {
        name: 'cached_tool',
        description: 'cached schema for the hung server',
        inputSchema: { type: 'object', properties: {} },
      };
      await fs.writeFile(
        path.join(tempDir, 'tools-cache.json'),
        JSON.stringify({
          'hanging-http': { tools: [cachedTool], cachedAt: '2026-07-31T00:00:00.000Z' },
        }),
      );

      client = new McpTestClient();
      const startedAt = Date.now();
      await client.start('node', [routerPath, '--config', configPath], {
        MCP_COMPRESS_ROUTER_HOME: tempDir,
      });
      const startupMs = Date.now() - startedAt;

      expect(startupMs).toBeLessThan(MAX_STARTUP_MS);
      expect(startupMs).toBeLessThan(STARTUP_BUDGET_MS);
      expect(client.isAlive()).toBe(true);

      // The router still serves: exactly two tools, and the healthy
      // server's tools are visible to get_tool_schema.
      const listResp = await client.sendRequest('tools/list');
      expect(listResp.error).toBeUndefined();
      const tools = (listResp.result as { tools: Array<{ name: string }> }).tools;
      expect(tools).toHaveLength(2);

      const schemaResp = await client.sendRequest('tools/call', {
        name: 'get_tool_schema',
        arguments: {
          server: 'stdio-fixture',
          tools: ['echo'],
        },
      });
      expect(schemaResp.error).toBeUndefined();
      const text = (schemaResp.result as { content: Array<{ type: string; text: string }> })
        .content[0].text;
      expect(text).toContain('echo');

      // The degraded (hung) server's cached schema is served too.
      const cachedResp = await client.sendRequest('tools/call', {
        name: 'get_tool_schema',
        arguments: {
          server: 'hanging-http',
          tools: ['cached_tool'],
        },
      });
      expect(cachedResp.error).toBeUndefined();
      const cachedText = (cachedResp.result as { content: Array<{ type: string; text: string }> })
        .content[0].text;
      expect(cachedText).toContain('cached_tool');
    },
    STARTUP_BUDGET_MS + 10_000,
  );
});
