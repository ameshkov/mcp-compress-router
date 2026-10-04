import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/**
 * Options controlling how {@link withFileLock} waits for and reclaims a
 * lock file.
 */
export interface FileLockOptions {
  /**
   * Maximum time (ms) to wait for the lock before failing. Defaults to
   * 15000.
   */
  timeoutMs?: number;
  /**
   * Age (ms) after which a lock file whose mtime has not been renewed is
   * considered abandoned and may be reclaimed. The holder renews the
   * mtime while its task runs, so a live holder is never reclaimed.
   * Defaults to 10000.
   */
  staleMs?: number;
  /**
   * Base delay (ms) between acquisition attempts; a random jitter of up
   * to the same duration is added so competing processes do not retry in
   * lockstep. Defaults to 25.
   */
  retryDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STALE_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 25;

/**
 * Type guard for Node.js system errors that carry a `code` property.
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

/**
 * Runs `task` while holding an exclusive lock at `lockPath`.
 *
 * The lock is a file created with the exclusive `wx` flag, so it works
 * across processes on the same host: every process that shares the path
 * contends on the same inode and the OS grants it to exactly one holder.
 * The file is removed when the task settles, even when it throws.
 *
 * A holder renews the lock file's mtime while its task runs; a lock whose
 * mtime stops advancing for `staleMs` is treated as abandoned (the holder
 * crashed or was killed) and is reclaimed by a waiter. Waiters give up
 * with a descriptive error after `timeoutMs`.
 *
 * Locking is advisory: it only coordinates code that goes through this
 * helper, and the critical section should stay short because other
 * processes wait for it.
 *
 * @param lockPath - Absolute path of the lock file (created on demand).
 * @param task - The operation to run while holding the lock.
 * @param options - Wait, staleness, and retry tuning.
 * @returns The task's result.
 * @throws When the lock cannot be acquired before `timeoutMs`, or the
 *   task throws (the lock is released first).
 */
export async function withFileLock<T>(
  lockPath: string,
  task: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  const token = await acquireLock(lockPath, timeoutMs, staleMs, retryDelayMs);
  const heartbeat = setInterval(
    () => {
      void fs.utimes(lockPath, new Date(), new Date()).catch(() => {});
    },
    Math.max(1, Math.floor(staleMs / 2)),
  );
  heartbeat.unref?.();

  try {
    return await task();
  } finally {
    clearInterval(heartbeat);
    await releaseLock(lockPath, token);
  }
}

/**
 * Creates the lock file, retrying with jittered delays until the timeout
 * elapses. An existing lock whose mtime is older than `staleMs` is
 * reclaimed and retried immediately: the stale file is atomically
 * renamed to a unique per-attempt path before removal, so when several
 * waiters observe the same abandoned lock exactly one rename succeeds
 * and the losers retry without touching a freshly created lock.
 *
 * @param lockPath - Absolute path of the lock file.
 * @param timeoutMs - Overall acquisition deadline.
 * @param staleMs - Age after which an existing lock is abandoned.
 * @param retryDelayMs - Base retry delay, jittered.
 * @returns A unique token identifying this holder, for safe release.
 * @throws When the lock is held by a live process past the deadline.
 */
async function acquireLock(
  lockPath: string,
  timeoutMs: number,
  staleMs: number,
  retryDelayMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const token = randomUUID();
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${process.pid} ${Date.now()} ${token}\n`);
      } finally {
        await handle.close();
      }
      return token;
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'EEXIST') {
        throw err;
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for lock: ${lockPath}`);
    }

    if (await isStale(lockPath, staleMs)) {
      // The holder crashed without releasing. Reclaim the abandoned
      // lock with an atomic rename: rename(2) fails with ENOENT once
      // another waiter has already reclaimed it, so exactly one waiter
      // wins and no waiter can delete a freshly created lock.
      const reclaimPath = `${lockPath}.reclaim-${token}`;
      try {
        await fs.rename(lockPath, reclaimPath);
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          // Another waiter reclaimed the stale lock first; retry now.
          continue;
        }
        throw err;
      }
      await fs.unlink(reclaimPath).catch(() => {});
      continue;
    }

    await sleep(retryDelayMs + Math.floor(Math.random() * retryDelayMs));
  }
}

/**
 * Whether an existing lock file is abandoned: its mtime has not been
 * renewed for longer than `staleMs`. A lock that disappeared between the
 * failed create and this check is also considered reclaimable.
 *
 * @param lockPath - Absolute path of the lock file.
 * @param staleMs - Age after which the lock is abandoned.
 * @returns True when the lock may be removed and retried.
 */
async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return true;
    }
    throw err;
  }
}

/**
 * Releases the lock, but only when the file still carries this holder's
 * token: if the lock went stale and another process reclaimed it, that
 * process's lock must not be deleted.
 *
 * A holder frozen mid-critical-section for longer than `staleMs` is
 * inherently reclaimable, because its heartbeat is frozen too: waiters
 * then legitimately treat the lock as abandoned and reclaim it while
 * the frozen holder still considers itself the owner. That is accepted
 * for this advisory scheme — the critical sections are short, and a
 * frozen process cannot be trusted to release anyway.
 *
 * @param lockPath - Absolute path of the lock file.
 * @param token - The token returned by {@link acquireLock}.
 */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    const raw = await fs.readFile(lockPath, 'utf-8');
    if (!raw.includes(token)) {
      return;
    }
    await fs.unlink(lockPath);
  } catch {
    // The lock file is already gone; nothing to release.
  }
}

/**
 * Waits for the given number of milliseconds.
 *
 * @param ms - Delay in milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
