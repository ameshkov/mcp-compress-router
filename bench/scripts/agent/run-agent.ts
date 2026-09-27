/**
 * Generic agent execution for the benchmark.
 *
 * Spawns the prepared agent command in the run's workspace, streams a
 * transcript, saves the raw NDJSON event stream next to the run, and
 * reports the exit outcome.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BenchAgent, PreparedRun } from '../configs/types.js';
import { collectOutput, spawnAgent, waitForExit } from './process.js';
import {
  createTranscriptState,
  handleClaudeLine,
  handleCodexLine,
  handleCopilotLine,
  handleOpencodeLine,
  type TranscriptState,
} from './transcript.js';

/** Outcome of one agent execution. */
export interface AgentExecution {
  /** Process exit code, or null when killed or not started. */
  exitCode: number | null;
  /** True when the run hit the timeout. */
  timedOut: boolean;
  /** LLM turns observed in the event stream. */
  steps: number;
  /** Session id reported by the agent. */
  sessionID: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Spawn error message, when the agent could not be started. */
  spawnError?: string;
}

/** Line handlers keyed by agent. */
const HANDLERS: Record<BenchAgent, (line: string, state: TranscriptState) => void> = {
  claude: handleClaudeLine,
  'claude-no-tool-search': handleClaudeLine,
  codex: handleCodexLine,
  copilot: handleCopilotLine,
  opencode: handleOpencodeLine,
  'opencode-v2': handleOpencodeLine,
};

/**
 * Runs one prepared agent session and saves its raw event stream.
 *
 * @param agent - The coding agent being driven.
 * @param prepared - The prepared command, arguments, and environment.
 * @param workspaceDir - Working directory for the agent.
 * @param timeoutMs - Maximum run duration.
 * @param eventsPath - Destination of the raw NDJSON event stream.
 * @returns The execution outcome.
 */
export async function executeAgentRun(
  agent: BenchAgent,
  prepared: PreparedRun,
  workspaceDir: string,
  timeoutMs: number,
  eventsPath: string,
): Promise<AgentExecution> {
  const startedAt = Date.now();
  const state = createTranscriptState();
  const child = spawnAgent(prepared.command, prepared.args, prepared.env, workspaceDir);
  const rawLines = collectOutput(child, (line) => HANDLERS[agent](line, state), agent);
  const exit = await waitForExit(child, timeoutMs);
  const durationMs = Date.now() - startedAt;

  await mkdir(dirname(eventsPath), { recursive: true });
  await writeFile(eventsPath, rawLines.length === 0 ? '' : `${rawLines.join('\n')}\n`, 'utf8');

  const execution: AgentExecution = {
    exitCode: exit.code,
    timedOut: exit.timedOut,
    steps: state.steps,
    sessionID: state.sessionID,
    durationMs,
  };
  if (exit.spawnError !== null) {
    execution.spawnError = exit.spawnError.message;
    console.error(`Failed to start ${agent}: ${exit.spawnError.message}`);
  } else if (exit.timedOut) {
    console.error(`${agent} did not finish within ${timeoutMs} ms.`);
  }
  console.log(
    `\n${agent} finished: ${state.steps} step(s), ` +
      `session ${state.sessionID === '' ? 'unknown' : state.sessionID}, ` +
      `${Math.round(durationMs / 1000)} s.`,
  );
  return execution;
}
