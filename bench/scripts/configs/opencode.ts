/**
 * OpenCode adapter for the benchmark.
 *
 * Maps the `BENCH_OPENCODE_*` variables onto a hermetic
 * `XDG_CONFIG_HOME` `opencode.json` and runs `opencode run --format
 * json`. Session usage lands in the hermetic `XDG_DATA_HOME`, which is
 * where `ccusage opencode` looks (`OPENCODE_DATA_DIR`).
 *
 * The `opencode` agent targets V1 (`opencode-ai`) and writes the V1
 * config shape; `opencode-v2` targets the separate `@opencode/cli`
 * package and writes the native V2 shape, where MCP servers live under
 * `mcp.servers` and run through Code Mode by default.
 *
 * Built-in providers (`anthropic`, `openai`, `deepseek`, `openrouter`)
 * get an `apiKey`/`baseURL` override plus an explicit model declaration,
 * so ids their bundled catalog does not list (OpenRouter aliases) still
 * resolve. Any other provider is declared as a custom
 * `@ai-sdk/openai-compatible` provider, so OpenAI-compatible gateways
 * work too.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { optionalEnv, requireEnv } from './env.js';
import type { McpServerSpec, PreparedRun, RunContext } from './types.js';

/** Providers OpenCode supports natively; all others need a custom declaration. */
const BUILTIN_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'openrouter'];

/** Default npm package for custom OpenAI-compatible providers. */
const DEFAULT_PROVIDER_NPM = '@ai-sdk/openai-compatible';

/** Credential and model settings read from the environment. */
export interface OpencodeCredentials {
  /** API key for the provider. */
  apiKey: string;
  /** Optional custom base URL. */
  baseUrl?: string;
  /** Model reference in `provider/model` form. */
  model: string;
  /** Optional npm package for a custom provider. */
  npm?: string;
}

/**
 * Reads and validates the OpenCode credentials.
 *
 * @param env - The source environment (bench/.env values).
 * @returns The validated credentials.
 * @throws Error when the API key or model is missing.
 */
export function opencodeCredentials(env: NodeJS.ProcessEnv): OpencodeCredentials {
  return {
    apiKey: requireEnv(env, 'BENCH_OPENCODE_API_KEY'),
    baseUrl: optionalEnv(env, 'BENCH_OPENCODE_BASE_URL'),
    model: requireEnv(env, 'BENCH_OPENCODE_MODEL'),
    npm: optionalEnv(env, 'BENCH_OPENCODE_NPM'),
  };
}

/**
 * Splits a `provider/model` reference.
 *
 * @param modelRef - The model reference.
 * @returns The provider and bare model name.
 * @throws Error when the reference is not in `provider/model` form.
 */
export function splitModelRef(modelRef: string): { provider: string; model: string } {
  const index = modelRef.indexOf('/');
  if (index <= 0 || index === modelRef.length - 1) {
    throw new Error(
      `BENCH_OPENCODE_MODEL must be "<provider>/<model>" (got "${modelRef}"). ` +
        'Example: anthropic/claude-sonnet-4-5.',
    );
  }
  return { provider: modelRef.slice(0, index), model: modelRef.slice(index + 1) };
}

/**
 * Renders the V1 `provider` block for the configured model.
 *
 * @param credentials - The validated credentials.
 * @returns The provider configuration object.
 * @throws Error when a custom provider has no base URL.
 */
function providerConfig(credentials: OpencodeCredentials): Record<string, unknown> {
  const { provider, model } = splitModelRef(credentials.model);
  const apiKey = '{env:BENCH_OPENCODE_API_KEY}';
  if (BUILTIN_PROVIDERS.includes(provider)) {
    const options: Record<string, string> = { apiKey };
    if (credentials.baseUrl !== undefined) {
      options.baseURL = credentials.baseUrl;
    }
    return { [provider]: { options, models: { [model]: { name: model } } } };
  }
  if (credentials.baseUrl === undefined) {
    throw new Error(
      `Custom provider "${provider}" needs BENCH_OPENCODE_BASE_URL in bench/.env ` +
        '(built-in providers: anthropic, openai, deepseek, openrouter).',
    );
  }
  return {
    [provider]: {
      npm: credentials.npm ?? DEFAULT_PROVIDER_NPM,
      name: `Benchmark provider (${provider})`,
      options: { baseURL: credentials.baseUrl, apiKey },
      models: { [model]: { name: model } },
    },
  };
}

/**
 * Renders the native V2 `providers` block for the configured model.
 *
 * V2 reads credentials from `settings` and needs the model declared
 * explicitly so ids its catalog does not list (OpenRouter `~latest`
 * aliases) still resolve. Custom providers also declare their runtime
 * package.
 *
 * @param credentials - The validated credentials.
 * @returns The provider configuration object.
 * @throws Error when a custom provider has no base URL.
 */
function providerConfigV2(credentials: OpencodeCredentials): Record<string, unknown> {
  const { provider, model } = splitModelRef(credentials.model);
  const settings: Record<string, string> = { apiKey: '{env:BENCH_OPENCODE_API_KEY}' };
  if (credentials.baseUrl !== undefined) {
    settings.baseURL = credentials.baseUrl;
  }
  const models = { [model]: { modelID: model } };
  if (BUILTIN_PROVIDERS.includes(provider)) {
    return { [provider]: { settings, models } };
  }
  if (credentials.baseUrl === undefined) {
    throw new Error(
      `Custom provider "${provider}" needs BENCH_OPENCODE_BASE_URL in bench/.env ` +
        '(built-in providers: anthropic, openai, deepseek, openrouter).',
    );
  }
  const npm = credentials.npm ?? DEFAULT_PROVIDER_NPM;
  return {
    [provider]: {
      package: npm.startsWith('@ai-sdk/') ? `aisdk:${npm}` : npm,
      name: `Benchmark provider (${provider})`,
      settings,
      models,
    },
  };
}

/**
 * Renders the `mcp` block for one run.
 *
 * @param servers - The MCP servers the agent should see.
 * @returns The MCP configuration object.
 */
function mcpConfig(servers: McpServerSpec[]): Record<string, unknown> {
  const mcp: Record<string, unknown> = {};
  for (const server of servers) {
    mcp[server.name] = {
      type: 'local',
      command: [server.command, ...server.args],
      environment: server.env,
      enabled: true,
    };
  }
  return mcp;
}

/**
 * Renders the native V2 `mcp.servers` block for one run.
 *
 * V2 keeps servers under `mcp.servers`, uses `disabled` instead of
 * `enabled`, and runs their tools through Code Mode by default.
 *
 * @param servers - The MCP servers the agent should see.
 * @returns The MCP configuration object.
 */
function mcpConfigV2(servers: McpServerSpec[]): Record<string, unknown> {
  const serverConfig: Record<string, unknown> = {};
  for (const server of servers) {
    serverConfig[server.name] = {
      type: 'local',
      command: [server.command, ...server.args],
      environment: server.env,
      disabled: false,
    };
  }
  return { servers: serverConfig };
}

/**
 * Prepares one hermetic OpenCode run.
 *
 * @param context - The run context.
 * @returns The prepared command, environment, and usage lookup.
 */
export async function prepareOpencodeRun(context: RunContext): Promise<PreparedRun> {
  const { paths, env: sourceEnv } = context;
  const credentials = opencodeCredentials(sourceEnv);
  const isV2 = context.agent === 'opencode-v2';
  const xdgConfig = join(paths.homeDir, '.config');
  const xdgData = join(paths.homeDir, '.local', 'share');
  const configPath = join(xdgConfig, 'opencode', 'opencode.json');
  await mkdir(join(xdgConfig, 'opencode'), { recursive: true });
  const shared = {
    $schema: 'https://opencode.ai/config.json',
    model: credentials.model,
    small_model: credentials.model,
    permission: 'allow',
  };
  const document = isV2
    ? {
        ...shared,
        providers: providerConfigV2(credentials),
        mcp: mcpConfigV2(context.servers),
      }
    : {
        ...shared,
        provider: providerConfig(credentials),
        mcp: mcpConfig(context.servers),
      };
  await writeFile(configPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const env: NodeJS.ProcessEnv = {
    ...sourceEnv,
    HOME: paths.homeDir,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
  };
  delete env.OPENCODE_CONFIG;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;

  return {
    command: 'opencode',
    args: ['run', '--format', 'json', '--model', credentials.model, context.prompt],
    env,
    usageEnv: { OPENCODE_DATA_DIR: join(xdgData, 'opencode') },
    usageSource: 'opencode',
    model: credentials.model,
    configFiles: [relative(paths.runDir, configPath)],
  };
}
