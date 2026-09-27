#!/usr/bin/env tsx
/**
 * Runs one isolated benchmark run inside an agent container.
 *
 * Layout per run (all fresh, so runs never pollute each other):
 * - `workspace/` — the agent's working directory (the coding task)
 * - `home/`      — hermetic HOME with the agent's config and usage data
 * - `agent-config/` — generated MCP configuration for this run
 * - `router-home/`  — router mode only: `mcp.json` with the four mocks
 * - `events.ndjson`, `mcp-invocations.ndjson`, `summary.json`, `meta.json`
 *
 * Usage:
 *   tsx bench/scripts/run.ts --agent claude --mode direct
 *   tsx bench/scripts/run.ts --agent codex --mode router --timeout 600000
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { executeAgentRun, type AgentExecution } from './agent/run-agent.js';
import { scriptArgs } from './args.js';
import { prepareClaudeRun } from './configs/claude.js';
import { prepareCodexRun } from './configs/codex.js';
import { prepareCopilotRun } from './configs/copilot.js';
import { prepareOpencodeRun } from './configs/opencode.js';
import { buildMockServers, buildRouterServer, writeRouterConfig } from './configs/servers.js';
import {
  ALL_AGENTS,
  type BenchAgent,
  type BenchMode,
  type McpServerSpec,
  type PreparedRun,
  type RunContext,
  type RunPaths,
} from './configs/types.js';
import { formatRunId } from './run-id.js';
import type { RunSummary } from './run-summary.js';
import { collectUsage, type UsageReport } from './usage.js';

/** Default agent timeout: 30 minutes. */
const DEFAULT_TIMEOUT_MS = 1_800_000;

/** Default runs directory inside the benchmark image. */
const DEFAULT_RUNS_DIR = '/bench/runs';

/** Default prompt file, relative to the repository root. */
const DEFAULT_PROMPT_FILE = 'bench/prompts/todo-app.md';

/**
 * Validates the `--agent` option.
 *
 * @param value - The raw option value.
 * @returns The validated agent.
 * @throws Error when the value is missing or unknown.
 */
function parseAgent(value: string | undefined): BenchAgent {
  if (value !== undefined && (ALL_AGENTS as readonly string[]).includes(value)) {
    return value as BenchAgent;
  }
  throw new Error(
    `Missing or unknown --agent "${value ?? ''}" (expected ${ALL_AGENTS.join(', ')}).`,
  );
}

/**
 * Validates the `--mode` option.
 *
 * @param value - The raw option value.
 * @returns The validated mode.
 * @throws Error when the value is missing or unknown.
 */
function parseMode(value: string | undefined): BenchMode {
  if (value === 'direct' || value === 'router') {
    return value;
  }
  throw new Error(`Missing or unknown --mode "${value ?? ''}" (expected direct, router).`);
}

/**
 * Resolves the run timeout from the CLI or `BENCH_TIMEOUT_MS`.
 *
 * @param value - The raw `--timeout` value.
 * @returns The timeout in milliseconds.
 * @throws Error when the value is not a positive number.
 */
function parseTimeout(value: string | undefined): number {
  const raw = value ?? process.env.BENCH_TIMEOUT_MS;
  if (raw === undefined || raw === '') {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid timeout "${raw}" (expected milliseconds).`);
  }
  return Math.floor(parsed);
}

/**
 * Builds the absolute run directory layout.
 *
 * @param repoRoot - The repository root baked into the image.
 * @param runsRoot - The directory holding all runs.
 * @param runId - The run identifier.
 * @returns The run paths.
 */
function createPaths(repoRoot: string, runsRoot: string, runId: string): RunPaths {
  const runDir = join(runsRoot, runId);
  return {
    repoRoot,
    runDir,
    workspaceDir: join(runDir, 'workspace'),
    homeDir: join(runDir, 'home'),
    configDir: join(runDir, 'agent-config'),
    routerHomeDir: join(runDir, 'router-home'),
    invocationLog: join(runDir, 'mcp-invocations.ndjson'),
  };
}

/**
 * Reads the coding task prompt.
 *
 * @param repoRoot - The repository root.
 * @param explicitPath - Optional `--prompt` override.
 * @returns The prompt text.
 */
async function readPrompt(repoRoot: string, explicitPath: string | undefined): Promise<string> {
  const path = explicitPath ?? process.env.BENCH_PROMPT_FILE ?? join(repoRoot, DEFAULT_PROMPT_FILE);
  return readFile(path, 'utf8');
}

/**
 * Counts the logged mock MCP tool invocations.
 *
 * @param path - The invocation log path.
 * @returns The number of non-empty log lines.
 */
async function countInvocations(path: string): Promise<number> {
  try {
    const text = await readFile(path, 'utf8');
    return text.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}

/**
 * Prepares the agent-specific configuration for one run.
 *
 * @param agent - The coding agent.
 * @param context - The run context.
 * @returns The prepared command, environment, and usage lookup.
 */
function prepareRun(agent: BenchAgent, context: RunContext): Promise<PreparedRun> {
  switch (agent) {
    case 'claude':
    case 'claude-no-tool-search':
      return prepareClaudeRun(context);
    case 'codex':
      return prepareCodexRun(context);
    case 'copilot':
      return prepareCopilotRun(context);
    case 'opencode':
      return prepareOpencodeRun(context);
    case 'opencode-v2':
      return prepareOpencodeRun(context);
  }
}

/**
 * Prints the one-line run summary.
 *
 * @param summary - The completed run summary.
 */
function printSummary(summary: RunSummary): void {
  console.log(`\n=== ${summary.runId} ===`);
  if (summary.usage.available && summary.usage.totals !== undefined) {
    const totals = summary.usage.totals;
    console.log(
      `Tokens: ${totals.totalTokens.toLocaleString('en-US')} total ` +
        `(input ${totals.inputTokens.toLocaleString('en-US')}, ` +
        `cache read ${totals.cacheReadTokens.toLocaleString('en-US')}, ` +
        `cache create ${totals.cacheCreationTokens.toLocaleString('en-US')}, ` +
        `output ${totals.outputTokens.toLocaleString('en-US')}) | ` +
        `cost $${totals.totalCost.toFixed(4)}`,
    );
  } else {
    console.log(`Usage unavailable: ${summary.usage.error ?? 'unknown error'}`);
  }
  console.log(
    `MCP stub invocations: ${summary.mcpInvocations} | ` +
      `agent steps: ${summary.steps} | exit ${String(summary.exitCode)}`,
  );
}

/** Parsed options of one benchmark run invocation. */
interface RunOptions {
  /** The coding agent. */
  agent: BenchAgent;
  /** Direct MCP servers or via the router. */
  mode: BenchMode;
  /** Explicit run id override. */
  runId?: string;
  /** Agent timeout in milliseconds. */
  timeoutMs: number;
  /** Explicit prompt file override. */
  prompt?: string;
  /** Whether ccusage should use cached pricing only. */
  offline: boolean;
}

/** Everything prepared before the agent process starts. */
interface RunSetup {
  /** The prepared agent invocation. */
  prepared: PreparedRun;
  /** The MCP servers exposed to the agent. */
  servers: McpServerSpec[];
  /** Router config path in router mode. */
  routerConfig?: string;
}

/** Measured inputs of a completed run. */
interface SummaryInput {
  /** The run options. */
  options: RunOptions;
  /** The run identifier. */
  runId: string;
  /** The prepared agent invocation. */
  prepared: PreparedRun;
  /** The agent execution outcome. */
  execution: AgentExecution;
  /** The ccusage lookup result. */
  usage: UsageReport;
  /** Number of mock MCP tool invocations. */
  mcpInvocations: number;
  /** ISO timestamp when the agent started. */
  startedAt: string;
  /** ISO timestamp when the agent finished. */
  finishedAt: string;
}

/**
 * Parses the command line of one benchmark run.
 *
 * @returns The validated options.
 */
function parseRunOptions(): RunOptions {
  const { values } = parseArgs({
    args: scriptArgs(process.argv.slice(2)),
    options: {
      agent: { type: 'string' },
      mode: { type: 'string' },
      'run-id': { type: 'string' },
      timeout: { type: 'string' },
      prompt: { type: 'string' },
      offline: { type: 'boolean', default: false },
    },
  });
  return {
    agent: parseAgent(values.agent),
    mode: parseMode(values.mode),
    runId: values['run-id'],
    timeoutMs: parseTimeout(values.timeout),
    prompt: values.prompt,
    offline: values.offline || process.env.BENCH_CCUSAGE_OFFLINE === '1',
  };
}

/**
 * Prepares the run directory, MCP configs, and agent invocation.
 *
 * @param options - The validated run options.
 * @param runId - The run identifier.
 * @param paths - The run directory layout.
 * @returns The prepared setup.
 */
async function prepareSetup(
  options: RunOptions,
  runId: string,
  paths: RunPaths,
): Promise<RunSetup> {
  await mkdir(paths.workspaceDir, { recursive: true });
  await mkdir(paths.homeDir, { recursive: true });
  await mkdir(paths.configDir, { recursive: true });
  const mockServers = buildMockServers(paths);
  const servers = options.mode === 'direct' ? mockServers : [buildRouterServer(paths)];
  const routerConfig =
    options.mode === 'router' ? await writeRouterConfig(paths, mockServers) : undefined;
  const prompt = await readPrompt(paths.repoRoot, options.prompt);
  const context: RunContext = {
    agent: options.agent,
    mode: options.mode,
    runId,
    paths,
    servers,
    prompt,
    env: process.env,
  };
  return { prepared: await prepareRun(options.agent, context), servers, routerConfig };
}

/**
 * Builds the persisted run summary.
 *
 * @param input - The measured run inputs.
 * @returns The run summary.
 */
function buildSummary(input: SummaryInput): RunSummary {
  return {
    runId: input.runId,
    agent: input.options.agent,
    mode: input.options.mode,
    model: input.prepared.model,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    exitCode: input.execution.exitCode,
    timedOut: input.execution.timedOut,
    durationMs: input.execution.durationMs,
    steps: input.execution.steps,
    sessionID: input.execution.sessionID,
    mcpInvocations: input.mcpInvocations,
    usage: input.usage,
  };
}

/**
 * Builds the debug manifest for a run.
 *
 * @param summary - The run summary.
 * @param setup - The prepared setup.
 * @param execution - The agent execution outcome.
 * @param options - The run options.
 * @returns The run manifest.
 */
function buildMeta(
  summary: RunSummary,
  setup: RunSetup,
  execution: AgentExecution,
  options: RunOptions,
): Record<string, unknown> {
  return {
    ...summary,
    timeoutMs: options.timeoutMs,
    offline: options.offline,
    configFiles: setup.prepared.configFiles,
    routerConfig: setup.routerConfig,
    servers: setup.servers.map((server) => server.name),
    spawnError: execution.spawnError,
  };
}

/**
 * Runs one benchmark run end to end.
 */
async function main(): Promise<void> {
  const options = parseRunOptions();
  const runsRoot = process.env.BENCH_RUNS_DIR ?? DEFAULT_RUNS_DIR;
  const runId = options.runId ?? formatRunId(options.agent, options.mode);
  const paths = createPaths(process.cwd(), runsRoot, runId);
  const setup = await prepareSetup(options, runId, paths);

  console.log(
    `Run ${runId}: agent=${options.agent} mode=${options.mode} model=${setup.prepared.model}`,
  );
  console.log(`Workspace: ${paths.workspaceDir}`);
  console.log(`Servers: ${setup.servers.map((server) => server.name).join(', ')}\n`);

  const startedAt = new Date().toISOString();
  const execution = await executeAgentRun(
    options.agent,
    setup.prepared,
    paths.workspaceDir,
    options.timeoutMs,
    join(paths.runDir, 'events.ndjson'),
  );
  const usage = await collectUsage(
    setup.prepared.usageSource,
    setup.prepared.usageEnv,
    options.offline,
  );
  const mcpInvocations = await countInvocations(paths.invocationLog);
  const finishedAt = new Date().toISOString();
  const summary = buildSummary({
    options,
    runId,
    prepared: setup.prepared,
    execution,
    usage,
    mcpInvocations,
    startedAt,
    finishedAt,
  });
  await writeFile(join(paths.runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(
    join(paths.runDir, 'meta.json'),
    `${JSON.stringify(buildMeta(summary, setup, execution, options), null, 2)}\n`,
  );
  printSummary(summary);

  if (execution.spawnError !== undefined || execution.timedOut || execution.exitCode !== 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`bench run failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
