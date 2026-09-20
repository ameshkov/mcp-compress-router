/**
 * opencode runner for the manual QA stack.
 *
 * Drives a real opencode session against the compiled router and the
 * mock LLM container, with a hermetic scratch `XDG_CONFIG_HOME` so the
 * tester's global opencode config, plugins, and MCP servers are ignored:
 *
 *   1. writes `qa/fixtures/opencode/opencode.jsonc` into a scratch
 *      config home with the mock LLM URL substituted,
 *   2. runs `opencode run --format json --model qa-mock/qa-mock`,
 *   3. streams the transcript (`[tool]` calls and `[assistant]` text),
 *   4. optionally saves the raw event stream for debugging.
 *
 * The mock LLM is a separate compose service; this module only needs
 * its URL (`QA_LLM_URL`, set by the compose workspace; a missing value
 * is an error).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectOutput,
  createScratchDir,
  reportSession,
  saveEvents,
  spawnAgent,
  waitForExit,
} from './process.js';
import { handleEventLine, type TranscriptState } from './transcript.js';
import type { AgentListOptions, AgentRunOptions, AgentRunResult } from './types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CONFIG_TEMPLATE = resolve(REPO_ROOT, 'qa', 'fixtures', 'opencode', 'opencode.jsonc');
const MODEL_REF = 'qa-mock/qa-mock';
const SCRATCH_PREFIX = 'mcp-compress-router-qa-';

/**
 * Writes the opencode config into a scratch XDG_CONFIG_HOME.
 *
 * @param scratch - The scratch directory.
 * @param llmUrl - The mock LLM base URL.
 */
async function writeScratchConfig(scratch: string, llmUrl: string): Promise<void> {
  const template = await readFile(CONFIG_TEMPLATE, 'utf8');
  const configDir = join(scratch, 'opencode');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, 'opencode.jsonc'),
    template.replaceAll('__LLM_URL__', llmUrl),
    'utf8',
  );
}

/**
 * Builds the child environment for a hermetic opencode run.
 *
 * @param scratch - The scratch XDG_CONFIG_HOME directory.
 * @returns The environment for opencode.
 */
function opencodeEnv(scratch: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: scratch };
  delete env.OPENCODE_CONFIG;
  return env;
}

/**
 * Runs one scripted opencode session and prints the transcript.
 *
 * @param options - The session options.
 * @returns The session outcome.
 */
export async function runOpencodeSession(options: AgentRunOptions): Promise<AgentRunResult> {
  const scratch = await createScratchDir(SCRATCH_PREFIX);
  try {
    await writeScratchConfig(scratch, options.llmUrl);
    console.log(`Prompt: ${options.prompt}\n`);
    const child = spawnAgent(
      'opencode',
      ['run', '--format', 'json', '--model', MODEL_REF, options.prompt],
      opencodeEnv(scratch),
      REPO_ROOT,
    );
    const state: TranscriptState = { sessionID: '', toolCalls: 0 };
    const { rawLines } = collectOutput(child, state, handleEventLine, 'opencode');
    const exit = await waitForExit(child, options.timeoutMs);
    if (options.eventsPath !== undefined) {
      await saveEvents(options.eventsPath, rawLines);
    }
    return reportSession('opencode', state, exit, options.timeoutMs);
  } finally {
    if (!options.keep) {
      await rm(scratch, { recursive: true, force: true });
    } else {
      console.log(`Scratch dir: ${scratch}`);
    }
  }
}

/**
 * Runs `opencode mcp list` with the hermetic QA config.
 *
 * @param options - The list options.
 * @returns The exit code for the probe process.
 */
export async function listOpencodeMcp(options: AgentListOptions): Promise<number> {
  const scratch = await createScratchDir(SCRATCH_PREFIX);
  try {
    await writeScratchConfig(scratch, options.llmUrl);
    console.log('opencode mcp list (hermetic config from qa/fixtures/opencode/opencode.jsonc)\n');
    const child = spawnAgent(
      'opencode',
      ['mcp', 'list'],
      opencodeEnv(scratch),
      REPO_ROOT,
      'inherit',
    );
    const exit = await waitForExit(child, options.timeoutMs);
    if (exit.spawnError) {
      console.error(`Failed to start opencode: ${exit.spawnError.message}`);
      return 1;
    }
    if (exit.timedOut) {
      console.error(`opencode did not finish within ${options.timeoutMs} ms.`);
      return 1;
    }
    return exit.code ?? 1;
  } finally {
    if (!options.keep) {
      await rm(scratch, { recursive: true, force: true });
    } else {
      console.log(`Scratch dir: ${scratch}`);
    }
  }
}
