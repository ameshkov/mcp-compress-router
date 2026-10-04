import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { routerPath } from './helpers.js';
import { McpTestClient } from './client.js';
import { createAuthFixtureServer, type AuthFixtureServer } from '../fixture-auth-server.js';
import { writeCredentials } from '../../src/cli/config-io.js';

/** Server name used in the temp config and the seeded credentials. */
const SERVER_NAME = 'auth-fixture';

/**
 * Polls the clients until every router process has exited, or the
 * timeout elapses. Called before inspecting the temp home so the lock
 * file of a process still shutting down is not mistaken for a leak.
 *
 * @param clients - The running test clients to wait for.
 * @param timeoutMs - Maximum time to wait, in milliseconds.
 * @returns True when every client process has exited.
 */
async function waitForClientsExit(clients: McpTestClient[], timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (clients.every((client) => !client.isAlive())) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return clients.every((client) => !client.isAlive());
}

describe('MCP Compress Router E2E — coordinated OAuth refresh', () => {
  it('refreshes a rejected access token once across concurrent router instances', async () => {
    const fixture: AuthFixtureServer = await createAuthFixtureServer();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-e2e-'));
    const clients: McpTestClient[] = [];
    try {
      // The provider drops every previously issued access token when it
      // rotates on refresh, like the providers that drive the refresh
      // storm: an instance that does not adopt the new token is 401ed.
      fixture.invalidatePreviousAccessToken();

      const configPath = path.join(tmpDir, 'mcp.json');
      await fs.writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            [SERVER_NAME]: {
              type: 'http',
              url: `${fixture.url}/mcp`,
              description: 'OAuth fixture server',
            },
          },
        }),
      );

      // The seeded access token was never issued by the fixture and its
      // expiry is far in the future, so proactive refresh cannot fire:
      // only the 401 on the first request can trigger a refresh.
      await writeCredentials(configPath, SERVER_NAME, {
        clientRegistration: { client_id: 'seed-client' },
        tokens: {
          access_token: 'at-seed',
          token_type: 'Bearer',
          refresh_token: 'rt-seed',
          expires_in: 3600,
          scope: 'read write',
          expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        },
        authRequirement: 'oauth',
        checkedAt: new Date().toISOString(),
      });

      for (let index = 0; index < 4; index += 1) {
        clients.push(new McpTestClient());
      }
      await Promise.all(
        clients.map((client) =>
          client.start('node', [routerPath, '--config', configPath], {
            MCP_COMPRESS_ROUTER_HOME: tmpDir,
          }),
        ),
      );

      const lists = await Promise.all(clients.map((client) => client.sendRequest('tools/list')));
      for (const resp of lists) {
        expect(resp.error).toBeUndefined();
        const getToolSchema = (
          resp.result as { tools: Array<{ name: string; description?: string }> }
        ).tools.find((tool) => tool.name === 'get_tool_schema')!;
        expect(getToolSchema.description).toContain(
          `- ${SERVER_NAME} (2 tools) - OAuth fixture server`,
        );
      }

      // Four instances hit the 401 concurrently; the cross-process
      // refresh lock serializes them so exactly one token request is
      // issued and the other three adopt the winner's token.
      expect(fixture.getTokenRequestCount()).toBe(1);

      const store = JSON.parse(
        await fs.readFile(path.join(tmpDir, 'credentials.json'), 'utf-8'),
      ) as Record<string, { tokens: { access_token: string } }>;
      const storedToken = store[SERVER_NAME].tokens.access_token;
      expect(storedToken).not.toBe('at-seed');
      expect(fixture.isAccessTokenValid(storedToken)).toBe(true);
      expect(fixture.isAccessTokenValid('at-seed')).toBe(false);

      // Close every client and the fixture, then wait for the router
      // processes to exit before checking the temp home, so a lock file
      // still held by a shutting-down process is not read as a leak.
      await Promise.all(clients.map((client) => client.close()));
      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
      expect(await waitForClientsExit(clients)).toBe(true);

      const leftovers = (await fs.readdir(tmpDir)).filter((entry) => entry.endsWith('.lock'));
      expect(leftovers).toEqual([]);
    } finally {
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
