/**
 * Shared child-process helpers for the coding-agent runners.
 *
 * Both runners need the same lifecycle around the agent process: a
 * scratch directory for the hermetic agent config, a bounded wait that
 * kills the agent on timeout, a line collector that streams the
 * transcript while keeping the raw event stream, and an optional dump
 * of that stream to a file.
 */
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AgentRunResult, AgentTranscriptState } from './types.js';

/** Outcome of waiting for a child process. */
export interface ExitResult {
  code: number | null;
  timedOut: boolean;
  spawnError: Error | null;
}

/**
 * Creates a scratch directory for a hermetic agent config.
 *
 * @param prefix - Prefix for the temporary directory name.
 * @returns The scratch directory path.
 */
export function createScratchDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Waits for a child process to exit, killing it after the timeout.
 *
 * @param child - The spawned child process.
 * @param timeoutMs - How long to wait before killing the child.
 * @returns The exit outcome.
 */
export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<ExitResult> {
  return new Promise((resolvePromise) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.once('error', (err: Error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, timedOut, spawnError: err });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, timedOut, spawnError: null });
    });
  });
}

/**
 * Writes the raw NDJSON event stream to a file.
 *
 * @param path - Destination path, relative to the working directory.
 * @param lines - The raw stdout lines.
 */
export async function saveEvents(path: string, lines: string[]): Promise<void> {
  const absolute = resolve(process.cwd(), path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Raw events: ${absolute}`);
}

/**
 * Streams a child's stdout through a line handler and captures stderr.
 *
 * @param child - The spawned agent process.
 * @param state - The mutable transcript state.
 * @param onLine - Handler for one stdout line.
 * @param label - Agent name used in the stderr header.
 * @returns The transcript state and raw stdout lines.
 */
export function collectOutput<T>(
  child: ChildProcess,
  state: T,
  onLine: (line: string, state: T) => void,
  label: string,
): { state: T; rawLines: string[] } {
  const rawLines: string[] = [];
  const rl = createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    rawLines.push(line);
    onLine(line, state);
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
    rl.close();
    if (stderr.trim() !== '') {
      console.error(`${label} stderr:\n${stderr.trim()}`);
    }
  };
  child.once('close', finish);
  child.once('error', finish);
  return { state, rawLines };
}

/**
 * Prints the session summary and maps the exit outcome to a result.
 *
 * @param label - Agent name used in the messages.
 * @param state - The collected transcript state.
 * @param exit - The exit outcome.
 * @param timeoutMs - The timeout the session ran with.
 * @returns The session outcome.
 */
export function reportSession(
  label: string,
  state: AgentTranscriptState,
  exit: ExitResult,
  timeoutMs: number,
): AgentRunResult {
  const session = state.sessionID === '' ? 'unknown' : state.sessionID;
  console.log(`\n${label} finished: ${state.toolCalls} tool call(s), session ${session}.`);
  if (exit.spawnError) {
    console.error(
      `Failed to start ${label}: ${exit.spawnError.message}\n` +
        'Run the plans inside the QA workspace (see qa/README.md).',
    );
    return { exitCode: 1, timedOut: false, toolCalls: state.toolCalls, sessionID: state.sessionID };
  }
  if (exit.timedOut) {
    console.error(`${label} did not finish within ${timeoutMs} ms.`);
  }
  return {
    exitCode: exit.code ?? 1,
    timedOut: exit.timedOut,
    toolCalls: state.toolCalls,
    sessionID: state.sessionID,
  };
}

/**
 * Spawns an agent command with the given environment.
 *
 * @param command - The executable to run.
 * @param args - Command-line arguments.
 * @param env - The child environment.
 * @param cwd - The working directory.
 * @param stdio - Stdio configuration (piped by default for transcripts).
 * @returns The spawned child process.
 */
export function spawnAgent(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  stdio: StdioOptions = ['ignore', 'pipe', 'pipe'],
): ChildProcess {
  return spawn(command, args, { cwd, env, stdio });
}
