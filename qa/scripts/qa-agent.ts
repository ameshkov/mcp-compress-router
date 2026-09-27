#!/usr/bin/env node
/**
 * Manual QA driver for coding-agent sessions.
 *
 * Runs a coding agent against the compiled router and the mock LLM
 * container, prints the agent transcript, and then reports the mock
 * LLM's validation results:
 *
 *   pnpm qa:agent --prompt "Test the stdio mcp server"
 *   pnpm qa:agent --agent copilot --prompt "Test the stdio mcp server"
 *   pnpm qa:agent --agent claude --prompt "Test the stdio mcp server"
 *   pnpm qa:agent --agent codex --prompt "Test the stdio mcp server"
 *   pnpm qa:agent --mcp-list
 *
 * Select the mock LLM script first with `pnpm qa:llm script <name>`;
 * the mock refuses to serve main requests without one. The command exits
 * 1 when the agent fails, times out, or any mock LLM validation check
 * failed, so a scenario can be judged from the exit code as well as from
 * `pnpm qa:llm log`.
 *
 * Options:
 * - `--prompt <text>` — prompt for the session (required unless `--mcp-list`).
 * - `--agent <name>` — coding agent to run (default `opencode`).
 * - `--timeout <ms>` — kill the agent after this budget.
 * - `--events <path>` — save the raw JSON event stream.
 * - `--keep` — keep the scratch agent config for debugging.
 * - `--mcp-list` — run the agent's MCP listing command instead of a session.
 * - `--real-llm` — opt-in: run opencode against OpenRouter with a real
 *   model instead of the mock LLM. Needs `QA_OPENROUTER_API_KEY` and
 *   optionally `QA_REAL_LLM_MODEL` in `qa/.env`; no mock LLM script is
 *   required and no mock LLM log is validated. Only valid for
 *   `--agent opencode`. The key is not needed with `--mcp-list`, which
 *   never contacts the model.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { listClaudeMcp, runClaudeSession } from './agent/claude.js';
import { listCodexMcp, runCodexSession } from './agent/codex.js';
import { listCopilotMcp, runCopilotSession } from './agent/copilot.js';
import { listOpencodeMcp, runOpencodeSession } from './agent/opencode.js';
import {
  REAL_LLM_DEFAULT_TIMEOUT_MS,
  resolveRealLlmModel,
  resolveRealLlmOptions,
} from './agent/real-llm.js';
import {
  AGENT_DEFAULT_TIMEOUT_MS,
  type AgentListOptions,
  type AgentName,
  type AgentRunOptions,
  type AgentRunResult,
} from './agent/types.js';
import {
  countFailedChecks,
  fetchLog,
  fetchStatus,
  llmBaseUrl,
  renderValidationSummary,
} from './mock-llm/client.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTER_ENTRY = resolve(REPO_ROOT, 'build', 'index.js');

/** Coding agents this driver can run. */
const SUPPORTED_AGENTS: AgentName[] = ['opencode', 'copilot', 'claude', 'codex'];

/** Session runners keyed by agent name. */
const AGENT_RUNNERS: Record<AgentName, (options: AgentRunOptions) => Promise<AgentRunResult>> = {
  opencode: runOpencodeSession,
  copilot: runCopilotSession,
  claude: runClaudeSession,
  codex: runCodexSession,
};

/** MCP listing commands keyed by agent name. */
const AGENT_LISTERS: Record<AgentName, (options: AgentListOptions) => Promise<number>> = {
  opencode: listOpencodeMcp,
  copilot: listCopilotMcp,
  claude: listClaudeMcp,
  codex: listCodexMcp,
};

/**
 * Parses and validates the `--timeout` value.
 *
 * @param raw - The raw option value.
 * @param fallback - Timeout used when the option is absent.
 * @returns The timeout in milliseconds.
 */
function parseTimeout(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid --timeout: ${raw}`);
  }
  return value;
}

/**
 * Parses and validates the `--agent` value.
 *
 * @param raw - The raw option value.
 * @returns The agent name.
 */
function parseAgent(raw: string | undefined): AgentName {
  const agent = raw ?? 'opencode';
  if (!SUPPORTED_AGENTS.includes(agent as AgentName)) {
    throw new Error(`Unknown agent "${agent}". Supported agents: ${SUPPORTED_AGENTS.join(', ')}.`);
  }
  return agent as AgentName;
}

/**
 * Dispatches to the selected coding agent.
 *
 * @param agent - The agent name.
 * @param options - The session options.
 * @returns The session outcome.
 */
async function runAgent(agent: AgentName, options: AgentRunOptions): Promise<AgentRunResult> {
  return AGENT_RUNNERS[agent](options);
}

/**
 * Dispatches to the selected agent's MCP listing command.
 *
 * @param agent - The agent name.
 * @param options - The list options.
 * @returns The exit code.
 */
async function listAgent(agent: AgentName, options: AgentListOptions): Promise<number> {
  return AGENT_LISTERS[agent](options);
}

/**
 * Builds the options for the agent's MCP listing command.
 *
 * The real-provider config is selected without requiring the OpenRouter
 * key: listing never contacts the model, so only real sessions need
 * credentials.
 *
 * @param realLlm - Whether `--real-llm` was passed.
 * @param timeout - The raw `--timeout` value.
 * @param keep - Whether to keep the scratch config home.
 * @returns The listing options.
 */
function buildListOptions(
  realLlm: boolean,
  timeout: string | undefined,
  keep: boolean,
): AgentListOptions {
  const realModel = realLlm ? { model: resolveRealLlmModel() } : undefined;
  return {
    llmUrl: realModel ? '' : llmBaseUrl(),
    timeoutMs: parseTimeout(
      timeout,
      realModel ? REAL_LLM_DEFAULT_TIMEOUT_MS : AGENT_DEFAULT_TIMEOUT_MS,
    ),
    keep,
    realLlm: realModel,
  };
}

/**
 * Runs one agent session and reports the mock LLM validation results.
 *
 * @param options - The session options.
 * @returns Process exit code.
 */
async function runSession(options: AgentRunOptions & { agent: AgentName }): Promise<number> {
  const status = await fetchStatus();
  if (status.script === null) {
    console.error(
      'No mock LLM script selected. Run "pnpm qa:llm list" and then ' +
        '"pnpm qa:llm script <name>" first.',
    );
    return 1;
  }
  const result = await runAgent(options.agent, options);
  const log = await fetchLog();
  console.log('\n--- mock LLM validation ---');
  console.log(renderValidationSummary(log));
  console.log('\nRun "pnpm qa:llm log" to inspect the raw requests and responses.');
  if (result.exitCode !== 0) {
    return result.exitCode;
  }
  if (result.timedOut) {
    return 1;
  }
  return countFailedChecks(log) > 0 ? 1 : 0;
}

/**
 * Runs one real-model session.
 *
 * There is no mock LLM log to validate: the agent transcript and the
 * mock MCP server logs are the evidence, so the exit code comes from
 * the agent alone.
 *
 * @param options - The session options (with `realLlm` set).
 * @returns Process exit code.
 */
async function runRealSession(options: AgentRunOptions & { agent: AgentName }): Promise<number> {
  console.log(`Real LLM: ${options.realLlm?.model} (OpenRouter)`);
  console.log('No mock LLM script is used; inspect the transcript and the mock MCP server logs.\n');
  const result = await runAgent(options.agent, options);
  if (result.exitCode !== 0) {
    return result.exitCode;
  }
  return result.timedOut ? 1 : 0;
}

/** Usage text shown when a required argument is missing. */
const USAGE =
  'Usage: pnpm qa:agent --prompt "<text>" [--agent opencode|copilot|claude|codex] ' +
  '[--timeout <ms>] [--events <path>] [--keep]\n' +
  '       pnpm qa:agent --mcp-list [--agent opencode|copilot|claude|codex]\n' +
  '       pnpm qa:agent --real-llm --prompt "<text>" [--timeout <ms>]';

/**
 * Runs the selected mode.
 *
 * @returns Process exit code.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      prompt: { type: 'string' },
      agent: { type: 'string', default: 'opencode' },
      timeout: { type: 'string' },
      events: { type: 'string' },
      keep: { type: 'boolean', default: false },
      'mcp-list': { type: 'boolean', default: false },
      'real-llm': { type: 'boolean', default: false },
    },
  });
  if (!existsSync(ROUTER_ENTRY)) {
    console.error(`Router build not found: ${ROUTER_ENTRY}\nRun "pnpm build" first.`);
    return 1;
  }
  const agent = parseAgent(values.agent);
  if (values['real-llm'] && agent !== 'opencode') {
    console.error('--real-llm is only supported for --agent opencode.');
    return 2;
  }
  if (values['mcp-list']) {
    return listAgent(agent, buildListOptions(values['real-llm'], values.timeout, values.keep));
  }
  if (values.prompt === undefined) {
    console.error(USAGE);
    return 2;
  }
  const realLlm = values['real-llm'] ? resolveRealLlmOptions() : undefined;
  const timeoutMs = parseTimeout(
    values.timeout,
    realLlm ? REAL_LLM_DEFAULT_TIMEOUT_MS : AGENT_DEFAULT_TIMEOUT_MS,
  );
  const llmUrl = realLlm ? '' : llmBaseUrl();
  const options = {
    agent,
    prompt: values.prompt,
    llmUrl,
    timeoutMs,
    eventsPath: values.events,
    keep: values.keep,
    realLlm,
  };
  return realLlm ? runRealSession(options) : runSession(options);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
