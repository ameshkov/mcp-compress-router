/**
 * Claude Code runner for the manual QA stack.
 *
 * Drives a real `claude -p` session against the compiled router and the
 * mock LLM container. Claude Code speaks the Anthropic Messages API, so
 * the run is hermetic in both directions: `ANTHROPIC_BASE_URL` points
 * at the mock LLM's Anthropic-compatible endpoint, `ANTHROPIC_AUTH_TOKEN`
 * and `ANTHROPIC_API_KEY` carry a dummy key, and `CLAUDE_CONFIG_DIR`
 * points at a scratch directory holding only the QA MCP config
 * (`qa/fixtures/claude/mcp-config.json`), so the tester's account,
 * settings, and MCP servers are never used.
 *
 *   1. writes the QA MCP config into the scratch config directory
 *      (user scope for `claude mcp list`, `--mcp-config` for sessions),
 *   2. runs `claude -p <prompt> --mcp-config ... --strict-mcp-config
 *      --output-format stream-json --verbose
 *      --dangerously-skip-permissions`,
 *   3. streams the transcript (`[tool]` calls and `[assistant]` text),
 *   4. optionally saves the raw event stream for debugging.
 *
 * `IS_SANDBOX=1` lets `--dangerously-skip-permissions` run as root
 * inside the throwaway workspace container; the other `CLAUDE_CODE_*`
 * and `DISABLE_*` variables keep the CLI away from telemetry and
 * auto-updates. The mock LLM is a separate compose service; this module
 * only needs its URL (`QA_LLM_URL`, set by the compose workspace; a
 * missing value is an error).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeTranscriptState, handleClaudeEventLine } from './claude-transcript.js';
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
const MCP_CONFIG_TEMPLATE = resolve(REPO_ROOT, 'qa', 'fixtures', 'claude', 'mcp-config.json');
const MODEL_ID = 'qa-mock';
const API_KEY = 'qa-mock-key';
const SCRATCH_PREFIX = 'mcp-compress-router-qa-claude-';

/**
 * Writes the QA MCP config into a scratch config directory.
 *
 * The same `{"mcpServers": ...}` document serves both entry points:
 * `.claude.json` is the user-scope config `claude mcp list` reads, and
 * `mcp-config.json` is passed to sessions with `--mcp-config` plus
 * `--strict-mcp-config`.
 *
 * @param scratch - The scratch directory.
 */
async function writeScratchConfig(scratch: string): Promise<void> {
  const template = await readFile(MCP_CONFIG_TEMPLATE, 'utf8');
  const configDir = join(scratch, '.claude');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, '.claude.json'), template, 'utf8');
  await writeFile(join(scratch, 'mcp-config.json'), template, 'utf8');
}

/**
 * Builds the child environment for a hermetic Claude Code run.
 *
 * @param scratch - The scratch config home.
 * @param llmUrl - The mock LLM base URL.
 * @returns The environment for Claude Code.
 */
function claudeEnv(scratch: string, llmUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: scratch,
    CLAUDE_CONFIG_DIR: join(scratch, '.claude'),
    ANTHROPIC_BASE_URL: llmUrl,
    ANTHROPIC_AUTH_TOKEN: API_KEY,
    ANTHROPIC_API_KEY: API_KEY,
    ANTHROPIC_MODEL: MODEL_ID,
    ANTHROPIC_SMALL_FAST_MODEL: MODEL_ID,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL_ID,
    IS_SANDBOX: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
  };
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  delete env.CLAUDE_CODE_USE_FOUNDRY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

/**
 * Runs one scripted Claude Code session and prints the transcript.
 *
 * @param options - The session options.
 * @returns The session outcome.
 */
export async function runClaudeSession(options: AgentRunOptions): Promise<AgentRunResult> {
  const scratch = await createScratchDir(SCRATCH_PREFIX);
  try {
    await writeScratchConfig(scratch);
    console.log(`Prompt: ${options.prompt}\n`);
    const child = spawnAgent(
      'claude',
      [
        '-p',
        options.prompt,
        '--mcp-config',
        join(scratch, 'mcp-config.json'),
        '--strict-mcp-config',
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
      ],
      claudeEnv(scratch, options.llmUrl),
      REPO_ROOT,
    );
    const state = createClaudeTranscriptState();
    const { rawLines } = collectOutput(child, state, handleClaudeEventLine, 'claude');
    const exit = await waitForExit(child, options.timeoutMs);
    if (options.eventsPath !== undefined) {
      await saveEvents(options.eventsPath, rawLines);
    }
    return reportSession('claude', state, exit, options.timeoutMs);
  } finally {
    if (!options.keep) {
      await rm(scratch, { recursive: true, force: true });
    } else {
      console.log(`Scratch dir: ${scratch}`);
    }
  }
}

/**
 * Runs `claude mcp list` with the hermetic QA config.
 *
 * @param options - The list options.
 * @returns The exit code for the probe process.
 */
export async function listClaudeMcp(options: AgentListOptions): Promise<number> {
  const scratch = await createScratchDir(SCRATCH_PREFIX);
  try {
    await writeScratchConfig(scratch);
    console.log('claude mcp list (hermetic config from qa/fixtures/claude/mcp-config.json)\n');
    const child = spawnAgent(
      'claude',
      ['mcp', 'list'],
      claudeEnv(scratch, options.llmUrl),
      REPO_ROOT,
      'inherit',
    );
    const exit = await waitForExit(child, options.timeoutMs);
    if (exit.spawnError) {
      console.error(`Failed to start claude: ${exit.spawnError.message}`);
      return 1;
    }
    if (exit.timedOut) {
      console.error(`claude did not finish within ${options.timeoutMs} ms.`);
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
