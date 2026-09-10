import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { killProcessTree } from './process-tree.js';

/** Wait for `pid` to no longer exist. */
async function waitForProcessExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * Script for a wrapper process that spawns a long-lived grandchild and
 * prints both pids as JSON — the same shape as an `npx`-style wrapper
 * around a real MCP server.
 */
const WRAPPER_SCRIPT = `
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  process.stdout.write(JSON.stringify({ wrapper: process.pid, child: child.pid }) + '\\n');
  setInterval(() => {}, 1000);
`;

/** Reads the wrapper/grandchild pids the wrapper script prints. */
function readTreePids(wrapper: ChildProcess): Promise<{ wrapper: number; child: number }> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    wrapper.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        return;
      }
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (err) {
        reject(err);
      }
    });
    wrapper.once('error', reject);
  });
}

describe.skipIf(process.platform === 'win32')('killProcessTree', () => {
  const spawned: ChildProcess[] = [];

  afterEach(async () => {
    for (const proc of spawned) {
      if (proc.pid !== undefined) {
        await killProcessTree(proc.pid);
      }
    }
    spawned.length = 0;
  });

  it('terminates the root process and its descendants', async () => {
    const wrapper = spawn(process.execPath, ['-e', WRAPPER_SCRIPT], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    spawned.push(wrapper);

    const pids = await readTreePids(wrapper);
    expect(pids.wrapper).toBeGreaterThan(0);
    expect(pids.child).toBeGreaterThan(0);

    await killProcessTree(pids.wrapper);

    expect(await waitForProcessExit(pids.wrapper)).toBe(true);
    expect(await waitForProcessExit(pids.child)).toBe(true);
  });

  it('resolves when the root process no longer exists', async () => {
    await expect(killProcessTree(999_999_999)).resolves.toBeUndefined();
  });
});
