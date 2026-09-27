/**
 * GitHub Copilot CLI adapter for the benchmark.
 *
 * Maps the `BENCH_COPILOT_*` variables onto a hermetic `COPILOT_HOME`
 * `mcp-config.json` and runs `copilot -p --output-format json`. The CLI
 * runs in BYOK mode (`COPILOT_PROVIDER_*`) against an OpenAI-compatible
 * endpoint with `COPILOT_OFFLINE=true`, so GitHub is never contacted and
 * no GitHub token is needed. Session events stay in the hermetic home,
 * which is where `ccusage copilot` looks (`COPILOT_HOME`).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { optionalEnv, requireEnv } from './env.js';
import type { McpServerSpec, PreparedRun, RunContext } from './types.js';

/** Credential and model settings read from the environment. */
export interface CopilotCredentials {
  /** API key for the BYOK provider. */
  apiKey: string;
  /** Base URL of the OpenAI-compatible provider. */
  baseUrl: string;
  /** Model id sent to the provider. */
  model: string;
  /** Optional wire API (`chat` is the default; `responses` is supported). */
  wireApi?: string;
}

/**
 * Reads and validates the Copilot credentials.
 *
 * @param env - The source environment (bench/.env values).
 * @returns The validated credentials.
 * @throws Error when the API key, base URL, or model is missing.
 */
export function copilotCredentials(env: NodeJS.ProcessEnv): CopilotCredentials {
  return {
    apiKey: requireEnv(env, 'BENCH_COPILOT_API_KEY'),
    baseUrl: requireEnv(env, 'BENCH_COPILOT_BASE_URL'),
    model: requireEnv(env, 'BENCH_COPILOT_MODEL'),
    wireApi: optionalEnv(env, 'BENCH_COPILOT_WIRE_API'),
  };
}

/**
 * Renders the `mcp-config.json` document for one run.
 *
 * @param servers - The MCP servers the agent should see.
 * @returns The MCP configuration object.
 */
function mcpDocument(servers: McpServerSpec[]): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      type: 'local',
      command: server.command,
      args: server.args,
      env: server.env,
      tools: ['*'],
    };
  }
  return { mcpServers };
}

/**
 * Prepares one hermetic Copilot CLI run.
 *
 * @param context - The run context.
 * @returns The prepared command, environment, and usage lookup.
 */
export async function prepareCopilotRun(context: RunContext): Promise<PreparedRun> {
  const { paths, env: sourceEnv } = context;
  const credentials = copilotCredentials(sourceEnv);
  const copilotHome = join(paths.homeDir, '.copilot');
  const configPath = join(copilotHome, 'mcp-config.json');
  await mkdir(copilotHome, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(mcpDocument(context.servers), null, 2)}\n`, 'utf8');

  const env: NodeJS.ProcessEnv = { ...sourceEnv, HOME: paths.homeDir };
  for (const key of Object.keys(env)) {
    if (key.startsWith('COPILOT_')) {
      delete env[key];
    }
  }
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  env.COPILOT_HOME = copilotHome;
  env.COPILOT_CACHE_HOME = join(paths.homeDir, '.cache', 'copilot');
  env.COPILOT_OFFLINE = 'true';
  env.COPILOT_AUTO_UPDATE = 'false';
  env.COPILOT_MCP_TOOL_CACHE = 'false';
  env.COPILOT_PROVIDER_TYPE = 'openai';
  env.COPILOT_PROVIDER_BASE_URL = credentials.baseUrl;
  env.COPILOT_PROVIDER_API_KEY = credentials.apiKey;
  env.COPILOT_MODEL = credentials.model;
  if (credentials.wireApi !== undefined) {
    env.COPILOT_PROVIDER_WIRE_API = credentials.wireApi;
  }

  return {
    command: 'copilot',
    args: ['-p', context.prompt, '--allow-all-tools', '--no-ask-user', '--output-format', 'json'],
    env,
    usageEnv: { COPILOT_HOME: copilotHome },
    usageSource: 'copilot',
    model: credentials.model,
    configFiles: [relative(paths.runDir, configPath)],
  };
}
