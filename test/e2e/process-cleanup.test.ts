import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { routerPath, resolveFixtureCommand, waitForProcessExit } from './helpers.js';
import { McpTestClient } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the wrapper fixture (spawns the real server as a child). */
const wrapperPath = path.resolve(__dirname, '..', 'fixture-wrapper-server.mjs');

/** Absolute path to the hung-stdio fixture server. */
const stuckServerPath = path.resolve(__dirname, '..', 'fixture-stuck-server.mjs');

/** Pids recorded by the wrapper fixture. */
interface TreePids {
  wrapper: number;
  server: number;
}

/** Waits for the wrapper fixture to record both pids. */
async function readTreePids(filePath: string, timeoutMs = 5000): Promise<TreePids> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as TreePids;
      if (parsed.wrapper > 0 && parsed.server > 0) {
        return parsed;
      }
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for the process-tree pid file: ${filePath}`);
}

/** Creates a unique temporary directory for one test. */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe('MCP Compress Router E2E — process tree cleanup', () => {
  let client: McpTestClient;
  let tempDir: string;
  let treePids: TreePids | undefined;
  const spawned: ChildProcess[] = [];

  afterEach(async () => {
    // Force-kill any recorded tree member that survived a failed assertion
    // so this test file never leaks the very orphans it checks for.
    for (const pid of treePids ? [treePids.wrapper, treePids.server] : []) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    treePids = undefined;
    for (const proc of spawned) {
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
    }
    spawned.length = 0;
    await client?.close();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('terminates the wrapper and the wrapped server on host disconnect', async () => {
    const fixture = await resolveFixtureCommand();
    tempDir = await makeTempDir('mcp-e2e-tree-shutdown');
    const pidFile = path.join(tempDir, 'tree.pids');

    const config = {
      mcpServers: {
        wrapped: {
          type: 'stdio',
          command: 'node',
          args: [wrapperPath, fixture.command, ...fixture.args],
          env: { MCP_TEST_TREE_PID_FILE: pidFile },
        },
      },
    };
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    client = new McpTestClient();
    await client.start('node', [routerPath, '--config', configPath], {
      MCP_COMPRESS_ROUTER_HOME: tempDir,
    });
    const listResp = await client.sendRequest('tools/list');
    expect(listResp.error).toBeUndefined();

    const pids = await readTreePids(pidFile);
    treePids = pids;
    await client.close();

    // Both the npx-style wrapper and the real server behind it must be
    // terminated, not just the router's direct child.
    expect(await waitForProcessExit(pids.wrapper)).toBe(true);
    expect(await waitForProcessExit(pids.server)).toBe(true);
  }, 30_000);

  it('terminates the wrapped tree when the handshake times out', async () => {
    tempDir = await makeTempDir('mcp-e2e-tree-timeout');
    const pidFile = path.join(tempDir, 'tree.pids');

    const config = {
      mcpServers: {
        wrapped: {
          type: 'stdio',
          command: 'node',
          args: [wrapperPath, 'node', stuckServerPath],
          env: { MCP_TEST_TREE_PID_FILE: pidFile },
        },
      },
    };
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    const proc = spawn('node', [routerPath, '-c', configPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MCP_COMPRESS_ROUTER_HOME: tempDir,
        MCP_COMPRESS_ROUTER_DOWNSTREAM_TIMEOUT_MS: '2000',
      },
    });
    spawned.push(proc);
    proc.stdout?.on('data', () => {});
    proc.stderr?.on('data', () => {});

    const pids = await readTreePids(pidFile);
    treePids = pids;

    // Wait for `exit`, not `close`: an orphaned grandchild would hold the
    // router's inherited stderr pipe open, so the `close` event would never
    // fire even after the router itself exited.
    const exitCode = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => resolve(-1), 10_000);
      proc.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });
    // No tool cache exists, so the handshake timeout is a cold fail-fast.
    expect(exitCode).toBe(1);

    expect(await waitForProcessExit(pids.wrapper)).toBe(true);
    expect(await waitForProcessExit(pids.server)).toBe(true);
  }, 30_000);
});
