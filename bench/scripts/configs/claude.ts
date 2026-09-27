/**
 * Claude Code adapter for the benchmark.
 *
 * Maps the `BENCH_CLAUDE_*` variables onto the CLI's native
 * configuration and runs a headless `claude -p` session with a hermetic
 * `CLAUDE_CONFIG_DIR` and `HOME`, so the image's own state can never
 * leak into a run. The session writes its JSONL usage log under the
 * hermetic config directory, which is exactly where `ccusage claude`
 * looks.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { optionalEnv, requireEnv } from './env.js';
import type { BenchAgent, McpServerSpec, PreparedRun, RunContext, RunPaths } from './types.js';

/** Claude measurement that loads every tool definition upfront. */
const NO_TOOL_SEARCH_AGENT: BenchAgent = 'claude-no-tool-search';

/** Credential and model settings read from the environment. */
export interface ClaudeCredentials {
  /** Anthropic API key (`ANTHROPIC_API_KEY`). */
  apiKey?: string;
  /** Gateway bearer token (`ANTHROPIC_AUTH_TOKEN`), when the gateway needs one. */
  authToken?: string;
  /** Subscription OAuth token from `claude setup-token`. */
  oauthToken?: string;
  /** Custom API base URL. */
  baseUrl?: string;
  /** Main model id. */
  model: string;
  /** Optional small/fast model override. */
  smallModel?: string;
}

/** Variables cleared before the run's credentials are applied. */
const HERMETIC_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];

/**
 * Reads and validates the Claude Code credentials.
 *
 * @param env - The source environment (bench/.env values).
 * @returns The validated credentials.
 * @throws Error when no credential or no model is configured.
 */
export function claudeCredentials(env: NodeJS.ProcessEnv): ClaudeCredentials {
  const credentials: ClaudeCredentials = {
    apiKey: optionalEnv(env, 'BENCH_CLAUDE_API_KEY'),
    authToken: optionalEnv(env, 'BENCH_CLAUDE_AUTH_TOKEN'),
    oauthToken: optionalEnv(env, 'BENCH_CLAUDE_OAUTH_TOKEN'),
    baseUrl: optionalEnv(env, 'BENCH_CLAUDE_BASE_URL'),
    model: requireEnv(env, 'BENCH_CLAUDE_MODEL'),
    smallModel: optionalEnv(env, 'BENCH_CLAUDE_SMALL_MODEL'),
  };
  if (
    credentials.apiKey === undefined &&
    credentials.authToken === undefined &&
    credentials.oauthToken === undefined
  ) {
    throw new Error(
      'Missing Claude Code credentials: set BENCH_CLAUDE_API_KEY, ' +
        'BENCH_CLAUDE_AUTH_TOKEN, or BENCH_CLAUDE_OAUTH_TOKEN in bench/.env.',
    );
  }
  return credentials;
}

/**
 * Renders the `--mcp-config` document for one run.
 *
 * @param servers - The MCP servers the agent should see.
 * @returns The JSON document text.
 */
function mcpConfigDocument(servers: McpServerSpec[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      type: 'stdio',
      command: server.command,
      args: server.args,
      env: server.env,
    };
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

/**
 * Builds the hermetic child environment for one Claude Code run.
 *
 * @param paths - The run directory layout.
 * @param credentials - The validated credentials.
 * @param sourceEnv - The source environment (bench/.env values).
 * @param agent - The Claude measurement being prepared.
 * @returns The child environment.
 */
function buildClaudeEnv(
  paths: RunPaths,
  credentials: ClaudeCredentials,
  sourceEnv: NodeJS.ProcessEnv,
  agent: BenchAgent,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...sourceEnv,
    HOME: paths.homeDir,
    CLAUDE_CONFIG_DIR: join(paths.homeDir, '.claude'),
    IS_SANDBOX: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
  };
  for (const key of HERMETIC_KEYS) {
    delete env[key];
  }
  env.ANTHROPIC_MODEL = credentials.model;
  if (agent === NO_TOOL_SEARCH_AGENT) {
    env.ENABLE_TOOL_SEARCH = 'false';
  }
  if (credentials.smallModel !== undefined) {
    env.ANTHROPIC_SMALL_FAST_MODEL = credentials.smallModel;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = credentials.smallModel;
  }
  if (credentials.oauthToken !== undefined) {
    env.CLAUDE_CODE_OAUTH_TOKEN = credentials.oauthToken;
  }
  if (credentials.authToken !== undefined) {
    env.ANTHROPIC_AUTH_TOKEN = credentials.authToken;
  }
  if (credentials.apiKey !== undefined) {
    env.ANTHROPIC_API_KEY = credentials.apiKey;
  }
  if (credentials.baseUrl !== undefined) {
    env.ANTHROPIC_BASE_URL = credentials.baseUrl;
  }
  return env;
}

/**
 * Prepares one hermetic Claude Code run.
 *
 * The default `claude` measurement keeps whatever Tool Search setting
 * `bench/.env` provides; `claude-no-tool-search` forces
 * `ENABLE_TOOL_SEARCH=false` so the router is measured against a host
 * that sends every MCP definition on every request.
 *
 * @param context - The run context.
 * @returns The prepared command, environment, and usage lookup.
 */
export async function prepareClaudeRun(context: RunContext): Promise<PreparedRun> {
  const { paths, env: sourceEnv } = context;
  const credentials = claudeCredentials(sourceEnv);
  const configDir = join(paths.homeDir, '.claude');
  const mcpConfigPath = join(paths.configDir, 'claude-mcp-config.json');
  await mkdir(configDir, { recursive: true });
  await mkdir(paths.configDir, { recursive: true });
  await writeFile(mcpConfigPath, mcpConfigDocument(context.servers), 'utf8');

  return {
    command: 'claude',
    args: [
      '-p',
      context.prompt,
      '--mcp-config',
      mcpConfigPath,
      '--strict-mcp-config',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ],
    env: buildClaudeEnv(paths, credentials, sourceEnv, context.agent),
    usageEnv: { CLAUDE_CONFIG_DIR: configDir },
    usageSource: 'claude',
    model: credentials.model,
    configFiles: [relative(paths.runDir, mcpConfigPath)],
  };
}
