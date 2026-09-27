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
 * With `--real-llm` the same flow uses
 * `qa/fixtures/opencode/opencode-real-llm.jsonc` instead: the model
 * reference comes from `QA_REAL_LLM_MODEL` and the OpenRouter key is
 * interpolated by opencode from `QA_OPENROUTER_API_KEY`, so the session
 * talks to a real model instead of the mock LLM.
 *
 * The mock LLM is a separate compose service; the mock path only needs
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
import { splitRealModelRef } from './real-llm.js';
import { handleEventLine, type TranscriptState } from './transcript.js';
import type { AgentListOptions, AgentRunOptions, AgentRunResult } from './types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CONFIG_TEMPLATE = resolve(REPO_ROOT, 'qa', 'fixtures', 'opencode', 'opencode.jsonc');
const REAL_CONFIG_TEMPLATE = resolve(
  REPO_ROOT,
  'qa',
  'fixtures',
  'opencode',
  'opencode-real-llm.jsonc',
);
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
 * Writes the real-LLM opencode config into a scratch XDG_CONFIG_HOME.
 *
 * @param scratch - The scratch directory.
 * @param modelRef - The `<provider>/<model>` reference to run.
 * @throws When the reference is not an OpenRouter reference.
 */
async function writeRealScratchConfig(scratch: string, modelRef: string): Promise<void> {
  const { model } = splitRealModelRef(modelRef);
  const template = await readFile(REAL_CONFIG_TEMPLATE, 'utf8');
  const configDir = join(scratch, 'opencode');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, 'opencode.jsonc'),
    template.replaceAll('__MODEL__', modelRef).replaceAll('__MODEL_ID__', model),
    'utf8',
  );
}

/**
 * Writes the scratch config for the selected LLM mode.
 *
 * @param scratch - The scratch directory.
 * @param options - The session or listing options.
 */
async function writeSelectedConfig(
  scratch: string,
  options: { llmUrl: string; realLlm?: { model: string } },
): Promise<void> {
  if (options.realLlm) {
    await writeRealScratchConfig(scratch, options.realLlm.model);
    return;
  }
  await writeScratchConfig(scratch, options.llmUrl);
}

/**
 * Returns the model reference for the selected LLM mode.
 *
 * @param options - The session or listing options.
 * @returns The model reference opencode runs with.
 */
function selectedModelRef(options: { realLlm?: { model: string } }): string {
  return options.realLlm?.model ?? MODEL_REF;
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
    await writeSelectedConfig(scratch, options);
    const modelRef = selectedModelRef(options);
    console.log(`Prompt: ${options.prompt}\n`);
    if (options.realLlm) {
      console.log(`Model: ${modelRef} (real LLM via OpenRouter)\n`);
    }
    const child = spawnAgent(
      'opencode',
      ['run', '--format', 'json', '--model', modelRef, options.prompt],
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
    await writeSelectedConfig(scratch, options);
    const template = options.realLlm
      ? 'qa/fixtures/opencode/opencode-real-llm.jsonc'
      : 'qa/fixtures/opencode/opencode.jsonc';
    console.log(`opencode mcp list (hermetic config from ${template})\n`);
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
