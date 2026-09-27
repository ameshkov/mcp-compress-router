/**
 * Opt-in real-LLM configuration for the manual QA agent driver.
 *
 * The regular QA plans drive the coding agents with the scripted mock
 * LLM, so no network access or credentials are needed. The real-LLM
 * plans are the exception: they run opencode against OpenRouter with a
 * real model to observe how a model discovers and uses the router. They
 * are opt-in and need `QA_OPENROUTER_API_KEY` (and optionally
 * `QA_REAL_LLM_MODEL`) in `qa/.env`; see qa/README.md.
 */
import process from 'node:process';
import type { RealLlmOptions } from './types.js';

/**
 * Default real-model reference used when `QA_REAL_LLM_MODEL` is unset.
 * The OpenRouter alias always points at the latest DeepSeek Flash
 * release.
 */
export const DEFAULT_REAL_LLM_MODEL = 'openrouter/~deepseek/deepseek-flash-latest';

/**
 * Default session timeout for real-model runs. A real model needs
 * longer than the scripted mock LLM (which answers instantly), so the
 * real-LLM plans get a larger budget unless `--timeout` overrides it.
 */
export const REAL_LLM_DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Resolves the real-model reference from the environment.
 *
 * Unlike {@link resolveRealLlmOptions}, this does not require the
 * OpenRouter key: the MCP listing mode never contacts the model, so it
 * can use the real-provider config without credentials. A blank value
 * is treated as unset, so `QA_REAL_LLM_MODEL=` falls back to the
 * default instead of failing the reference check.
 *
 * @param env - The source environment (defaults to `process.env`).
 * @returns The configured model reference, or the default.
 */
export function resolveRealLlmModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.QA_REAL_LLM_MODEL?.trim() || DEFAULT_REAL_LLM_MODEL;
}

/**
 * Resolves the real-LLM session options from the environment.
 *
 * @param env - The source environment (defaults to `process.env`).
 * @returns The validated options.
 * @throws When `QA_OPENROUTER_API_KEY` is not set.
 */
export function resolveRealLlmOptions(env: NodeJS.ProcessEnv = process.env): RealLlmOptions {
  if (!env.QA_OPENROUTER_API_KEY) {
    throw new Error(
      'QA_OPENROUTER_API_KEY is not set. Copy qa/.env.example to qa/.env, ' +
        'fill in the OpenRouter key, and recreate the workspace container ' +
        '(docker compose -f qa/docker-compose.yml up -d).',
    );
  }
  return { model: resolveRealLlmModel(env) };
}

/**
 * Splits and validates a real-model reference.
 *
 * Only the OpenRouter provider is supported, and the reference must be
 * `<provider>/<model>` so the bare model id can be declared in the
 * scratch opencode config (OpenRouter aliases are not in models.dev).
 *
 * @param modelRef - The configured model reference.
 * @returns The provider and the bare model id.
 * @throws When the reference is malformed or uses another provider.
 */
export function splitRealModelRef(modelRef: string): { provider: string; model: string } {
  const slash = modelRef.indexOf('/');
  if (slash <= 0 || slash === modelRef.length - 1) {
    throw new Error(`QA_REAL_LLM_MODEL must be "<provider>/<model>" (got "${modelRef}").`);
  }
  const provider = modelRef.slice(0, slash);
  if (provider !== 'openrouter') {
    throw new Error(`QA_REAL_LLM_MODEL must use the "openrouter" provider (got "${provider}").`);
  }
  return { provider, model: modelRef.slice(slash + 1) };
}
