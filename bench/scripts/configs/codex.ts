/**
 * Codex CLI adapter for the benchmark.
 *
 * Maps the `BENCH_CODEX_*` variables onto a hermetic `CODEX_HOME`
 * `config.toml` and runs `codex exec --json`. The session rollouts stay
 * on disk (no `--ephemeral`) under the hermetic home, which is where
 * `ccusage codex` looks. A custom `base_url` becomes a custom
 * `wire_api = "responses"` model provider, the only wire API Codex CLI
 * supports.
 *
 * The provider is declared even when no base URL is set (defaulting to
 * the OpenAI endpoint) and always sets `supports_websockets = false`.
 * Newer models such as `gpt-5.6-sol` advertise `prefer_websockets` in
 * Codex's built-in model catalog, and the Responses API WebSocket
 * transport authenticates from `$CODEX_HOME/auth.json` rather than an
 * API-key environment variable, so the key-only built-in provider fails
 * with `401 Unauthorized` on `wss://api.openai.com/v1/responses`.
 * Built-in providers cannot be overridden, so the harness routes every
 * run through its own HTTP-only provider instead.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { optionalEnv, requireEnv } from './env.js';
import type { McpServerSpec, PreparedRun, RunContext } from './types.js';

/** Credential and model settings read from the environment. */
export interface CodexCredentials {
  /** API key for the provider. */
  apiKey: string;
  /** Optional custom provider base URL (e.g. a gateway). */
  baseUrl?: string;
  /** Model id. */
  model: string;
  /** Wire API for a custom provider (`responses` by default). */
  wireApi: string;
}

/** Provider id and base URL used for runs without a custom endpoint. */
const BENCH_PROVIDER_ID = 'bench';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Reads and validates the Codex credentials.
 *
 * @param env - The source environment (bench/.env values).
 * @returns The validated credentials.
 * @throws Error when the API key or model is missing.
 */
export function codexCredentials(env: NodeJS.ProcessEnv): CodexCredentials {
  return {
    apiKey: requireEnv(env, 'BENCH_CODEX_API_KEY'),
    baseUrl: optionalEnv(env, 'BENCH_CODEX_BASE_URL'),
    model: requireEnv(env, 'BENCH_CODEX_MODEL'),
    wireApi: optionalEnv(env, 'BENCH_CODEX_WIRE_API') ?? 'responses',
  };
}

/**
 * Quotes a string as a TOML basic string.
 *
 * @param value - The raw value.
 * @returns The quoted value.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Renders the `config.toml` document for one run.
 *
 * @param credentials - The validated credentials.
 * @param servers - The MCP servers the agent should see.
 * @returns The TOML document text.
 */
function configDocument(credentials: CodexCredentials, servers: McpServerSpec[]): string {
  const lines = [
    `model = ${tomlString(credentials.model)}`,
    'approval_policy = "never"',
    'check_for_update_on_startup = false',
    `model_provider = ${tomlString(BENCH_PROVIDER_ID)}`,
    '',
    `[model_providers.${BENCH_PROVIDER_ID}]`,
    'name = "Benchmark provider"',
    `base_url = ${tomlString(credentials.baseUrl ?? DEFAULT_OPENAI_BASE_URL)}`,
    'env_key = "BENCH_CODEX_API_KEY"',
    `wire_api = ${tomlString(credentials.wireApi)}`,
    'supports_websockets = false',
  ];
  for (const server of servers) {
    const envEntries = Object.entries(server.env)
      .map(([key, value]) => `${key} = ${tomlString(value)}`)
      .join(', ');
    lines.push(
      '',
      `[mcp_servers.${server.name}]`,
      `command = ${tomlString(server.command)}`,
      `args = [${server.args.map(tomlString).join(', ')}]`,
      `env = { ${envEntries} }`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Prepares one hermetic Codex CLI run.
 *
 * @param context - The run context.
 * @returns The prepared command, environment, and usage lookup.
 */
export async function prepareCodexRun(context: RunContext): Promise<PreparedRun> {
  const { paths, env: sourceEnv } = context;
  const credentials = codexCredentials(sourceEnv);
  const codexHome = join(paths.homeDir, '.codex');
  const configPath = join(codexHome, 'config.toml');
  await mkdir(codexHome, { recursive: true });
  await writeFile(configPath, configDocument(credentials, context.servers), 'utf8');

  const env: NodeJS.ProcessEnv = {
    ...sourceEnv,
    HOME: paths.homeDir,
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: codexHome,
  };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;

  return {
    command: 'codex',
    args: [
      'exec',
      '--json',
      '--color',
      'never',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      context.prompt,
    ],
    env,
    usageEnv: { CODEX_HOME: codexHome },
    usageSource: 'codex',
    model: credentials.model,
    configFiles: [relative(paths.runDir, configPath)],
  };
}
