import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { routerPath, resolveFixtureCommand } from './helpers.js';
import { McpTestClient } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the hung-stdio fixture server. */
const stuckServerPath = path.resolve(__dirname, '..', 'fixture-stuck-server.mjs');

/** Wait for `pid` (a process id) to no longer exist. */
async function waitForProcessExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe('MCP Compress Router E2E — startup resilience', () => {
  let client: McpTestClient;
  let tempDir: string;
  let spawned: ChildProcess[] = [];

  afterEach(async () => {
    for (const proc of spawned) {
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
    }
    spawned = [];
    await client?.close();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('answers the host initialize immediately while a downstream is still connecting', async () => {
    const fixture = await resolveFixtureCommand();
    tempDir = path.join(
      tmpdir(),
      `mcp-e2e-startup-immediate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });

    const config = {
      mcpServers: {
        quick: { type: 'stdio', command: fixture.command, args: fixture.args },
        stuck: {
          type: 'stdio',
          command: 'node',
          args: [stuckServerPath],
        },
      },
    };
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    // Seed the tool cache for the stuck server so the router degrades
    // instead of failing fast once its connect times out.
    const cachedTool = {
      name: 'stuck_tool',
      description: 'cached schema for the stuck server',
      inputSchema: { type: 'object', properties: {} },
    };
    await fs.writeFile(
      path.join(tempDir, 'tools-cache.json'),
      JSON.stringify({
        stuck: { tools: [cachedTool], cachedAt: '2026-09-09T00:00:00.000Z' },
      }),
    );

    client = new McpTestClient();
    const startedAt = Date.now();
    await client.start('node', [routerPath, '--config', configPath], {
      MCP_COMPRESS_ROUTER_HOME: tempDir,
      MCP_COMPRESS_ROUTER_DOWNSTREAM_TIMEOUT_MS: '4000',
    });
    const initMs = Date.now() - startedAt;

    // The host-side initialize must be answered by the router itself
    // long before the stuck downstream gives up (4s timeout), i.e. the
    // router no longer gates the host handshake behind downstream
    // connects.
    expect(initMs).toBeLessThan(3000);

    // tools/list waits for the (bounded) connect phase and then shows
    // the final compact catalog including the degraded stuck server.
    const listResp = await client.sendRequest('tools/list');
    expect(listResp.error).toBeUndefined();
    const tools = (listResp.result as { tools: Array<{ name: string; description: string }> })
      .tools;
    expect(tools).toHaveLength(2);
    const gts = tools.find((t) => t.name === 'get_tool_schema')!;
    expect(gts.description).toContain('quick');
    expect(gts.description).toContain('stuck');

    // The degraded server's cached schema is still served.
    const schemaResp = await client.sendRequest('tools/call', {
      name: 'get_tool_schema',
      arguments: { server: 'stuck', tools: ['stuck_tool'] },
    });
    expect(schemaResp.error).toBeUndefined();
    const text = (schemaResp.result as { content: Array<{ type: string; text: string }> })
      .content[0].text;
    expect(text).toContain('stuck_tool');
  }, 30_000);

  it('exits cleanly and kills in-flight children when the host disconnects during connect', async () => {
    tempDir = path.join(
      tmpdir(),
      `mcp-e2e-shutdown-during-connect-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });
    const pidFile = path.join(tempDir, 'stuck.pid');

    const config = {
      mcpServers: {
        stuck: {
          type: 'stdio',
          command: 'node',
          args: [stuckServerPath],
          env: { MCP_TEST_PID_FILE: pidFile },
        },
      },
    };
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    const proc = spawn('node', [routerPath, '-c', configPath, '-v'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MCP_COMPRESS_ROUTER_HOME: tempDir },
    });
    spawned.push(proc);
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    proc.stdout?.on('data', () => {});

    // Wait until the stuck child has actually spawned (its connect is
    // in flight), then simulate the host disconnecting.
    let stuckPid: number | undefined;
    const spawnDeadline = Date.now() + 5000;
    while (stuckPid === undefined && Date.now() < spawnDeadline) {
      try {
        stuckPid = Number((await fs.readFile(pidFile, 'utf-8')).trim());
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(stuckPid).toBeDefined();

    proc.stdin?.end();
    const exitCode = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => resolve(-1), 8000);
      proc.once('close', (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });

    expect(exitCode).toBe(0);
    expect(stderr).toContain('stdin-closed');
    expect(stderr).toContain('Shutdown complete');

    // The in-flight downstream child must have been terminated rather
    // than orphaned by the router exiting mid-connect.
    expect(await waitForProcessExit(stuckPid as number)).toBe(true);
  }, 20_000);
});
