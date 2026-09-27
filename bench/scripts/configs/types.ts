/**
 * Shared types for the benchmark run preparation.
 *
 * An agent adapter turns a `RunContext` (layout, mock servers, prompt,
 * credentials from the environment) into a `PreparedRun`: the exact
 * command, arguments, child environment, and the ccusage lookup needed
 * to measure one isolated benchmark run.
 */

/**
 * Coding agents the benchmark can drive.
 *
 * Claude Code appears twice to measure the host-deferral difference:
 * `claude` keeps the default MCP Tool Search behavior, while
 * `claude-no-tool-search` forces `ENABLE_TOOL_SEARCH=false` so every
 * tool definition loads upfront on every request.
 */
export type BenchAgent =
  'claude' | 'claude-no-tool-search' | 'codex' | 'copilot' | 'opencode' | 'opencode-v2';

/** Every coding agent the benchmark can drive, in report order. */
export const ALL_AGENTS: readonly BenchAgent[] = [
  'claude',
  'claude-no-tool-search',
  'codex',
  'copilot',
  'opencode',
  'opencode-v2',
];

/** The two benchmark modes: direct MCP servers or via mcp-compress-router. */
export type BenchMode = 'direct' | 'router';

/** One MCP server the agent should connect to, in agent-agnostic form. */
export interface McpServerSpec {
  /** Unique server name shown to the agent. */
  name: string;
  /** Executable that starts the stdio server. */
  command: string;
  /** Arguments passed to the executable. */
  args: string[];
  /** Environment variables for the server process. */
  env: Record<string, string>;
  /** Human-readable description for configs that support one. */
  description: string;
}

/** Absolute paths that make up one isolated run directory. */
export interface RunPaths {
  /** Repository root baked into the benchmark image. */
  repoRoot: string;
  /** The run directory itself. */
  runDir: string;
  /** Fresh working directory the agent builds the task in. */
  workspaceDir: string;
  /** Fresh HOME for the agent. */
  homeDir: string;
  /** Directory for generated agent config files. */
  configDir: string;
  /** Router home (router mode only). */
  routerHomeDir: string;
  /** NDJSON log of mock MCP tool invocations. */
  invocationLog: string;
}

/** Everything needed to prepare one benchmark run. */
export interface RunContext {
  /** The coding agent to drive. */
  agent: BenchAgent;
  /** Direct MCP servers or the router. */
  mode: BenchMode;
  /** Unique run identifier. */
  runId: string;
  /** Absolute run directory layout. */
  paths: RunPaths;
  /** MCP servers the agent should see (already resolved for the mode). */
  servers: McpServerSpec[];
  /** The coding task prompt. */
  prompt: string;
  /** Source of the BENCH_* credential variables. */
  env: NodeJS.ProcessEnv;
}

/** One agent invocation prepared by an adapter. */
export interface PreparedRun {
  /** Executable to spawn. */
  command: string;
  /** Command-line arguments. */
  args: string[];
  /** Complete child environment (hermetic). */
  env: NodeJS.ProcessEnv;
  /** Environment for the ccusage lookup of this run's usage data. */
  usageEnv: NodeJS.ProcessEnv;
  /** ccusage data source for this agent. */
  usageSource: BenchAgent;
  /** Model id this run used. */
  model: string;
  /** Config files written for this run, relative to the run directory. */
  configFiles: string[];
}
