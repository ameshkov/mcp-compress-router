import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { routerPath, resolveFixtureCommand } from './helpers.js';

/**
 * Spawns the router as a subprocess and exposes a live view of its
 * accumulated stderr so tests can wait for a startup marker.
 */
function spawnRunningRouter(
  configPath: string,
  homeDir: string,
): { proc: ChildProcess; getStderr: () => string } {
  const proc = spawn('node', [routerPath, '--config', configPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MCP_COMPRESS_ROUTER_HOME: homeDir },
  });
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  // Drain stdout so the router can never block on a full pipe.
  proc.stdout?.on('data', () => {});
  return { proc, getStderr: () => stderr };
}

/**
 * Resolves when stderr contains `marker`. Rejects if the router exits
 * first or the marker does not appear within `timeoutMs`.
 */
async function waitForMarker(
  proc: ChildProcess,
  getStderr: () => string,
  marker: string,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (!getStderr().includes(marker)) {
    if (proc.exitCode !== null) {
      throw new Error(`router exited (code ${proc.exitCode}) before "${marker}"`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for "${marker}"\n${getStderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Resolves with the exit code, or -1 if the process does not exit in time. */
function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(-1), timeoutMs);
    proc.once('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

async function makeConfig(): Promise<{ configPath: string; tempDir: string }> {
  const tempDir = path.join(
    tmpdir(),
    `mcp-shutdown-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(tempDir, { recursive: true });
  const fixture = await resolveFixtureCommand();
  const config = {
    mcpServers: {
      fixture: {
        type: 'stdio',
        command: fixture.command,
        args: fixture.args,
        description: 'Fixture for shutdown test',
      },
    },
  };
  const configPath = path.join(tempDir, 'mcp.json');
  await fs.writeFile(configPath, JSON.stringify(config));
  return { configPath, tempDir };
}

describe('MCP Compress Router — graceful shutdown', () => {
  it('exits cleanly when the host closes stdin without sending a signal', async () => {
    const { configPath, tempDir } = await makeConfig();
    const { proc, getStderr } = spawnRunningRouter(configPath, tempDir);

    try {
      await waitForMarker(proc, getStderr, 'Server started');
      // Without the shutdown fix the router would hang here forever: the
      // SDK ignores stdin EOF and spawned downstream servers keep the
      // event loop alive.
      proc.stdin?.end();
      const exitCode = await waitForExit(proc, 8000);

      expect(exitCode).toBe(0);
      expect(getStderr()).toContain('stdin-closed');
      expect(getStderr()).toContain('Shutdown complete');
    } finally {
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);

  it('exits cleanly on SIGTERM after running cleanup hooks', async () => {
    const { configPath, tempDir } = await makeConfig();
    const { proc, getStderr } = spawnRunningRouter(configPath, tempDir);

    try {
      await waitForMarker(proc, getStderr, 'Server started');
      proc.kill('SIGTERM');
      const exitCode = await waitForExit(proc, 8000);

      // A signal death would surface as `null`/`-1`; a clean 0 means the
      // signal handler ran the coordinator and force-exited afterwards.
      expect(exitCode).toBe(0);
      expect(getStderr()).toContain('signal:SIGTERM');
      expect(getStderr()).toContain('Closing downstream server connections');
      expect(getStderr()).toContain('Shutdown complete');
    } finally {
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);
});
