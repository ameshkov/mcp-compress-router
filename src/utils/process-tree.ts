import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** How long to wait for a tree to exit after SIGTERM before SIGKILL. */
const DEFAULT_GRACE_MS = 1_000;

/** Poll interval used while waiting for processes to disappear. */
const POLL_INTERVAL_MS = 25;

/** Process-table size bound for `ps`; fits even large host tables. */
const PS_MAX_BUFFER = 16 * 1024 * 1024;

/** A single process-table row: process id and parent process id. */
interface ProcessEntry {
  pid: number;
  ppid: number;
}

/**
 * Terminates a process and every descendant it has spawned.
 *
 * This is required for stdio downstream servers launched through a
 * wrapper — `npx`, `npm exec`, a shell script — where the actual MCP
 * server is a grandchild of the router. The MCP SDK's transport only
 * signals the direct child, so a wrapper that exits (or is killed)
 * while the real server still holds the inherited stdio pipes leaves
 * that server orphaned with a dead peer.
 *
 * On POSIX the descendant list is resolved from one `ps` snapshot
 * taken while the tree is still intact, then the whole tree gets
 * `SIGTERM` followed by `SIGKILL` for survivors after a short grace
 * period. On Windows a `taskkill /T /F` is used.
 *
 * Best-effort and never rejects: missing processes, a failed
 * `ps`/`taskkill` invocation, and permission errors are ignored.
 *
 * @param rootPid - Pid of the direct child (the wrapper, when one is
 *   used).
 */
export async function killProcessTree(rootPid: number): Promise<void> {
  if (process.platform === 'win32') {
    await taskkillTree(rootPid);
    return;
  }

  const pids = await collectTreePids(rootPid);
  signalProcesses(pids, 'SIGTERM');
  await waitForExit(pids, DEFAULT_GRACE_MS);
  signalProcesses(pids.filter(isAlive), 'SIGKILL');
}

/**
 * Collects `rootPid` plus all of its descendants from a single `ps`
 * snapshot. Falls back to just the root when the process table cannot
 * be read.
 *
 * @param rootPid - Pid of the tree root.
 * @returns Root pid followed by its descendants.
 */
async function collectTreePids(rootPid: number): Promise<number[]> {
  const table = await readProcessTable();
  const childrenByParent = new Map<number, number[]>();
  for (const entry of table) {
    const children = childrenByParent.get(entry.ppid);
    if (children === undefined) {
      childrenByParent.set(entry.ppid, [entry.pid]);
    } else {
      children.push(entry.pid);
    }
  }

  const pids = [rootPid];
  for (let index = 0; index < pids.length; index += 1) {
    const children = childrenByParent.get(pids[index]);
    if (children !== undefined) {
      pids.push(...children);
    }
  }
  return pids;
}

/**
 * Reads the POSIX process table via `ps`. Returns an empty list when
 * `ps` is unavailable or fails.
 *
 * @returns Parsed pid/parent-pid rows.
 */
async function readProcessTable(): Promise<ProcessEntry[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid='], {
      maxBuffer: PS_MAX_BUFFER,
    });
    const entries: ProcessEntry[] = [];
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (match !== null) {
        entries.push({ pid: Number(match[1]), ppid: Number(match[2]) });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Sends `signal` to every pid, ignoring pids that are already gone or
 * cannot be signalled.
 *
 * @param pids - Target process ids.
 * @param signal - Signal to deliver.
 */
function signalProcesses(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited or not signalable; nothing to do.
    }
  }
}

/**
 * Returns whether a pid still exists.
 *
 * @param pid - Process id to probe.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits until every pid is gone or the grace period expires.
 *
 * @param pids - Process ids to await.
 * @param timeoutMs - Maximum time to wait.
 */
async function waitForExit(pids: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pids.some(isAlive)) {
    await delay(POLL_INTERVAL_MS);
  }
}

/**
 * Force-kills a Windows process tree rooted at `pid` and falls back to
 * a direct kill if `taskkill` is unavailable.
 *
 * @param pid - Root process id.
 */
async function taskkillTree(pid: number): Promise<void> {
  try {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']);
  } catch {
    // taskkill is unavailable or the process is already gone.
  }
  signalProcesses([pid], 'SIGKILL');
}

/**
 * Promise that resolves after `ms` milliseconds.
 *
 * @param ms - Delay in milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
