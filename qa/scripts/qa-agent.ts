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
 * @returns The timeout in milliseconds.
 */
function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) {
    return AGENT_DEFAULT_TIMEOUT_MS;
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
    },
  });
  if (!existsSync(ROUTER_ENTRY)) {
    console.error(`Router build not found: ${ROUTER_ENTRY}\nRun "pnpm build" first.`);
    return 1;
  }
  const llmUrl = llmBaseUrl();
  const timeoutMs = parseTimeout(values.timeout);
  const agent = parseAgent(values.agent);
  if (values['mcp-list']) {
    return listAgent(agent, { llmUrl, timeoutMs, keep: values.keep });
  }
  if (values.prompt === undefined) {
    console.error(
      'Usage: pnpm qa:agent --prompt "<text>" [--agent opencode|copilot|claude|codex] ' +
        '[--timeout <ms>] [--events <path>] [--keep]\n' +
        '       pnpm qa:agent --mcp-list [--agent opencode|copilot|claude|codex]',
    );
    return 2;
  }
  return runSession({
    agent,
    prompt: values.prompt,
    llmUrl,
    timeoutMs,
    eventsPath: values.events,
    keep: values.keep,
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
