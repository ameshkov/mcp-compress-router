import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFileLock } from './file-lock.js';

describe('withFileLock', () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-file-lock-'));
    lockPath = path.join(tmpDir, 'test.lock');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('serializes concurrent tasks that hold the same lock', async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3].map((id) =>
        withFileLock(lockPath, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          order.push(id);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
        }),
      ),
    );

    expect(maxActive).toBe(1);
    expect(order).toHaveLength(3);
  });

  it('removes the lock file when the task finishes', async () => {
    await withFileLock(lockPath, async () => {});

    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('releases the lock when the task throws', async () => {
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error('task failed');
      }),
    ).rejects.toThrow('task failed');

    // The lock is free again: the next task acquires it immediately.
    await expect(withFileLock(lockPath, async () => 'ok')).resolves.toBe('ok');
  });

  it('fails after the timeout while a live holder keeps the lock', async () => {
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withFileLock(lockPath, async () => {
      acquired();
      await held;
    });

    // Wait until the holder owns the lock before contending for it.
    await acquiredPromise;

    await expect(
      withFileLock(lockPath, async () => 'never', {
        timeoutMs: 100,
        staleMs: 10_000,
        retryDelayMs: 5,
      }),
    ).rejects.toThrow(/Timed out after 100ms waiting for lock/);

    release();
    await holder;
  });

  it("reclaims a dead holder's lock before the timeout", async () => {
    // A lock file older than staleMs with nobody renewing its mtime.
    // staleMs is well below timeoutMs, so the dead holder is reclaimed
    // long before the waiter gives up.
    await fs.writeFile(lockPath, '99999 0 abandoned\n');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);

    await expect(
      withFileLock(lockPath, async () => 'acquired', {
        timeoutMs: 5_000,
        staleMs: 100,
        retryDelayMs: 5,
      }),
    ).resolves.toBe('acquired');
  });

  it('serializes two reclaimers of the same stale lock', async () => {
    // Both waiters observe the same abandoned lock; reclamation must
    // hand it to exactly one of them.
    await fs.writeFile(lockPath, '99999 0 abandoned\n');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);

    let active = 0;
    let maxActive = 0;
    await Promise.all(
      [1, 2].map((id) =>
        withFileLock(
          lockPath,
          async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
            return id;
          },
          { timeoutMs: 5_000, staleMs: 1_000, retryDelayMs: 5 },
        ),
      ),
    );

    expect(maxActive).toBe(1);
  });

  it('leaves a lock carrying a foreign token in place on release', async () => {
    await withFileLock(
      lockPath,
      async () => {
        // Simulate a reclaimer that took over after this holder froze
        // for longer than staleMs: the file now carries its token.
        await fs.writeFile(lockPath, '99999 1 foreign-token\n');
      },
      { timeoutMs: 2_000, staleMs: 10_000, retryDelayMs: 5 },
    );

    // The token check makes release a no-op, so the reclaimer's lock
    // survives the old holder's cleanup.
    await expect(fs.readFile(lockPath, 'utf-8')).resolves.toContain('foreign-token');
  });
});
