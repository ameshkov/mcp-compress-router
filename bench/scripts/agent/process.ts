/**
 * Child-process helpers for the benchmark agent runners.
 *
 * Every agent process is started in its own process group (`detached`),
 * so a timeout can terminate the agent together with the MCP server
 * children it spawned instead of leaving them behind.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Outcome of waiting for an agent process. */
export interface ExitResult {
  /** Exit code, or null when the process was killed or failed to spawn. */
  code: number | null;
  /** True when the configured timeout elapsed and the process was killed. */
  timedOut: boolean;
  /** Spawn error, when the executable could not be started. */
  spawnError: Error | null;
}

/**
 * Sends a signal to a child's process group, falling back to the child.
 *
 * @param child - The spawned process.
 * @param signal - The signal to send.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * Spawns an agent command with the given environment.
 *
 * @param command - The executable to run.
 * @param args - Command-line arguments.
 * @param env - The child environment.
 * @param cwd - The working directory.
 * @returns The spawned child process.
 */
export function spawnAgent(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): ChildProcess {
  return spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
}

/**
 * Waits for a child to exit, killing its process group after the timeout.
 *
 * @param child - The spawned child process.
 * @param timeoutMs - How long to wait before killing the process group.
 * @returns The exit outcome.
 */
export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<ExitResult> {
  return new Promise((resolvePromise) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.once('error', (error: Error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, timedOut, spawnError: error });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, timedOut, spawnError: null });
    });
  });
}

/**
 * Streams a child's stdout through a line handler and captures stderr.
 *
 * @param child - The spawned agent process.
 * @param onLine - Handler for one stdout line.
 * @param label - Agent name used in the stderr header.
 * @returns The raw stdout lines.
 */
export function collectOutput(
  child: ChildProcess,
  onLine: (line: string) => void,
  label: string,
): string[] {
  const rawLines: string[] = [];
  const reader = createInterface({ input: child.stdout! });
  reader.on('line', (line) => {
    rawLines.push(line);
    onLine(line);
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let finished = false;
  const finish = (): void => {
    if (finished) {
      return;
    }
    finished = true;
    reader.close();
    if (stderr.trim() !== '') {
      console.error(`${label} stderr:\n${stderr.trim()}`);
    }
  };
  child.once('close', finish);
  child.once('error', finish);
  return rawLines;
}
