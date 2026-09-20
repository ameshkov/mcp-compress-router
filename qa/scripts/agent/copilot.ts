/**
 * Copilot CLI runner for the manual QA stack.
 *
 * Drives a real `copilot -p` session against the compiled router and
 * the mock LLM container. The run is hermetic: `COPILOT_HOME` points at
 * a scratch directory holding only the QA MCP config
 * (`qa/fixtures/copilot/mcp-config.json`), the provider is configured
 * with BYOK environment variables (`COPILOT_PROVIDER_*`, `COPILOT_MODEL`)
 * pointing at the mock LLM, `COPILOT_OFFLINE=true` keeps the CLI away
 * from GitHub, and any GitHub tokens inherited from the environment are
 * removed, so the tester's account and configuration are never used.
 *
 *   1. writes the QA MCP config into the scratch `COPILOT_HOME`,
 *   2. runs `copilot -p <prompt> --allow-all-tools --no-ask-user
 *      --output-format json`,
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
import { createCopilotTranscriptState, handleCopilotEventLine } from './copilot-transcript.js';
import {
  collectOutput,
  createScratchDir,
  reportSession,
  saveEvents,
  spawnAgent,
  waitForExit,
} from './process.js';
import type { AgentListOptions, AgentRunOptions, AgentRunResult } from './types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MCP_CONFIG_TEMPLATE = resolve(REPO_ROOT, 'qa', 'fixtures', 'copilot', 'mcp-config.json');
const MODEL_ID = 'qa-mock';
const API_KEY = 'qa-mock-key';
const SCRATCH_PREFIX = 'mcp-compress-router-qa-copilot-';

/**
 * Writes the QA MCP config into a scratch COPILOT_HOME.
 *
 * @param scratch - The scratch directory.
 */
async function writeScratchConfig(scratch: string): Promise<void> {
  const template = await readFile(MCP_CONFIG_TEMPLATE, 'utf8');
  await mkdir(scratch, { recursive: true });
  await writeFile(join(scratch, 'mcp-config.json'), template, 'utf8');
}

/**
 * Builds the child environment for a hermetic Copilot CLI run.
 *
 * @param scratch - The scratch COPILOT_HOME directory.
 * @param llmUrl - The mock LLM base URL.
 * @returns The environment for Copilot CLI.
 */
function copilotEnv(scratch: string, llmUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COPILOT_HOME: scratch,
    COPILOT_OFFLINE: 'true',
    COPILOT_AUTO_UPDATE: 'false',
    COPILOT_MCP_TOOL_CACHE: 'false',
    COPILOT_PROVIDER_TYPE: 'openai',
    COPILOT_PROVIDER_BASE_URL: `${llmUrl}/v1`,
    COPILOT_PROVIDER_API_KEY: API_KEY,
    COPILOT_MODEL: MODEL_ID,
  };
  delete env.COPILOT_GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.COPILOT_PROVIDERS_CONFIG;
  return env;
}

/**
 * Runs one scripted Copilot CLI session and prints the transcript.
 *
 * @param options - The session options.
 * @returns The session outcome.
 */
export async function runCopilotSession(options: AgentRunOptions): Promise<AgentRunResult> {
  const scratch = await createScratchDir(SCRATCH_PREFIX);
  try {
    await writeScratchConfig(scratch);
    console.log(`Prompt: ${options.prompt}\n`);
    const child = spawnAgent(
      'copilot',
      ['-p', options.prompt, '--allow-all-tools', '--no-ask-user', '--output-format', 'json'],
      copilotEnv(scratch, options.llmUrl),
      REPO_ROOT,
    );
    const state = createCopilotTranscriptState();
    const { rawLines } = collectOutput(child, state, handleCopilotEventLine, 'copilot');
    const exit = await waitForExit(child, options.timeoutMs);
    if (options.eventsPath !== undefined) {
      await saveEvents(options.eventsPath, rawLines);
    }
    return reportSession('copilot', state, exit, options.timeoutMs);
  } finally {
    if (!options.keep) {
      await rm(scratch, { recursive: true, force: true });
    } else {
      console.log(`Scratch dir: ${scratch}`);
    }
  }
}

/**
 * Runs `copilot mcp list` with the hermetic QA config.
 *
 * @param options - The list options.
 * @returns The exit code for the probe process.
 */
export async function listCopilotMcp(options: AgentListOptions): Promise<number> {
  const scratch = await createScratchDir(SCRATCH_PREFIX);
  try {
    await writeScratchConfig(scratch);
    console.log('copilot mcp list (hermetic config from qa/fixtures/copilot/mcp-config.json)\n');
    const child = spawnAgent(
      'copilot',
      ['mcp', 'list'],
      copilotEnv(scratch, options.llmUrl),
      REPO_ROOT,
      'inherit',
    );
    const exit = await waitForExit(child, options.timeoutMs);
    if (exit.spawnError) {
      console.error(`Failed to start copilot: ${exit.spawnError.message}`);
      return 1;
    }
    if (exit.timedOut) {
      console.error(`copilot did not finish within ${options.timeoutMs} ms.`);
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
