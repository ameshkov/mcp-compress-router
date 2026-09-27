/**
 * Environment-variable helpers for the benchmark credential contract.
 *
 * All credentials, base URLs, and model names arrive through
 * `bench/.env` as `BENCH_*` variables, which the per-agent adapters map
 * onto each agent's native configuration. Missing required values fail
 * fast with a message pointing at `bench/.env.example`.
 */

/**
 * Reads a required environment variable.
 *
 * @param env - The source environment.
 * @param name - The variable name.
 * @returns The trimmed value.
 * @throws Error when the variable is unset or empty.
 */
export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`Missing ${name}. Copy bench/.env.example to bench/.env and fill it in.`);
  }
  return value;
}

/**
 * Reads an optional environment variable.
 *
 * @param env - The source environment.
 * @param name - The variable name.
 * @returns The trimmed value, or undefined when unset or empty.
 */
export function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}
