/**
 * Codex CLI runner for the manual QA stack.
 *
 * Drives a real `codex exec` session against the compiled router and the
 * mock LLM container. Codex CLI speaks the OpenAI Responses API, so the
 * run is hermetic in both directions: `CODEX_HOME` points at a scratch
 * directory holding a `config.toml` with a custom model provider that
 * targets the mock LLM's Responses endpoint (`wire_api = "responses"`
 * plus the `QA_MOCK_API_KEY` env var) and the QA MCP config
 * (`qa/fixtures/codex/config.toml`), so the tester's account, settings,
 * and MCP servers are never used.
 *
 *   1. writes the QA config into the scratch `CODEX_HOME`,
 *   2. runs `codex exec --json --color never --skip-git-repo-check
 *      --dangerously-bypass-approvals-and-sandbox --ephemeral <prompt>`,
 *   3. streams the transcript (`[tool]` calls and `[assistant]` text),
 *   4. optionally saves the raw event stream for debugging.
 *
 * `--dangerously-bypass-approvals-and-sandbox` is required inside the
 * throwaway workspace container: Codex's Linux sandbox needs namespace
 * and `bwrap` operations Docker blocks, and the container itself is the
 * security boundary. The mock LLM is a separate compose service; this
 * module only needs its URL (`QA_LLM_URL`, set by the compose workspace;
 * a missing value is an error).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexTranscriptState, handleCodexEventLine } from './codex-transcript.js';
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
const CONFIG_TEMPLATE = resolve(REPO_ROOT, 'qa', 'fixtures', 'codex', 'config.toml');
const API_KEY = 'qa-mock-key';
const SCRATCH_PREFIX = 'mcp-compress-router-qa-codex-';

/**
 * Writes the QA config into a scratch CODEX_HOME.
 *
 * @param scratch - The scratch CODEX_HOME directory.
 * @param llmUrl - The mock LLM base URL.
 */
async function writeScratchConfig(scratch: string, llmUrl: string): Promise<void> {
  const template = await readFile(CONFIG_TEMPLATE, 'utf8');
  await mkdir(scratch, { recursive: true });
  await writeFile(join(scratch, 'config.toml'), template.replaceAll('__LLM_URL__', llmUrl), 'utf8');
}

/**
 * Builds the child environment for a hermetic Codex CLI run.
 *
 * @param scratch - The scratch CODEX_HOME directory.
 * @returns The environment for Codex CLI.
 */
function codexEnv(scratch: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: scratch,
    CODEX_SQLITE_HOME: scratch,
    QA_MOCK_API_KEY: API_KEY,
  };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;
  return env;
}

/**
 * Runs one scripted Codex CLI session and prints the transcript.
 *
 * @param options - The session options.
 * @returns The session outcome.
 */
export async function runCodexSession(options: AgentRunOptions): Promise<AgentRunResult> {
  const scratch = await createScratchDir(SCRATCH_PREFIX);
  try {
    await writeScratchConfig(scratch, options.llmUrl);
    console.log(`Prompt: ${options.prompt}\n`);
    const child = spawnAgent(
      'codex',
      [
        'exec',
        '--json',
        '--color',
        'never',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '--ephemeral',
        options.prompt,
      ],
      codexEnv(scratch),
      REPO_ROOT,
    );
    const state = createCodexTranscriptState();
    const { rawLines } = collectOutput(child, state, handleCodexEventLine, 'codex');
    const exit = await waitForExit(child, options.timeoutMs);
    if (options.eventsPath !== undefined) {
      await saveEvents(options.eventsPath, rawLines);
    }
    return reportSession('codex', state, exit, options.timeoutMs);
  } finally {
    if (!options.keep) {
      await rm(scratch, { recursive: true, force: true });
    } else {
      console.log(`Scratch dir: ${scratch}`);
    }
  }
}

/**
 * Runs `codex mcp list --json` with the hermetic QA config.
 *
 * @param options - The list options.
 * @returns The exit code for the probe process.
 */
export async function listCodexMcp(options: AgentListOptions): Promise<number> {
  const scratch = await createScratchDir(SCRATCH_PREFIX);
  try {
    await writeScratchConfig(scratch, options.llmUrl);
    console.log('codex mcp list --json (hermetic config from qa/fixtures/codex/config.toml)\n');
    const child = spawnAgent(
      'codex',
      ['mcp', 'list', '--json'],
      codexEnv(scratch),
      REPO_ROOT,
      'inherit',
    );
    const exit = await waitForExit(child, options.timeoutMs);
    if (exit.spawnError) {
      console.error(`Failed to start codex: ${exit.spawnError.message}`);
      return 1;
    }
    if (exit.timedOut) {
      console.error(`codex did not finish within ${options.timeoutMs} ms.`);
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
