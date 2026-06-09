/**
 * Error thrown when a `${VAR}` reference references an undefined
 * environment variable and has no default value.
 *
 * @public
 */
export class ExpandEnvError extends Error {
  /** The name of the unresolved variable. */
  public readonly variableName: string;
  /** The field or context where the unresolved variable was found. */
  public readonly context: string;

  constructor(variableName: string, context: string) {
    super(`Environment variable "${variableName}" is not set (referenced in ${context})`);
    this.name = 'ExpandEnvError';
    this.variableName = variableName;
    this.context = context;
  }
}

// Matches ${VAR} and ${VAR:-default}
const ENV_REF_RE = /\$\{([A-Za-z_]\w*)(?::-(.*?))?\}/g;

/**
 * Expands `${VAR}` and `${VAR:-default}` references in a string value.
 *
 * - `${VAR}` is replaced with `process.env[VAR]`. If VAR is not set,
 *   throws {@link ExpandEnvError}.
 * - `${VAR:-default}` is replaced with `process.env[VAR]` if set and
 *   non-empty, otherwise with `default`.
 *
 * @param value - The string containing potentially unexpanded references.
 * @param context - Human-readable description of where the value comes
 *   from (e.g. `server "github" command`), used in error messages.
 * @returns The expanded string.
 * @throws {ExpandEnvError} When a `${VAR}` reference has no default and
 *   the variable is not set in the environment.
 *
 * @public
 */
export function expandEnvField(value: string, context: string): string {
  return value.replace(ENV_REF_RE, (match, varName: string, defaultVal: string | undefined) => {
    const envValue = process.env[varName];
    if (envValue !== undefined && envValue !== '') {
      return envValue;
    }
    if (defaultVal !== undefined) {
      return defaultVal;
    }
    throw new ExpandEnvError(varName, context);
  });
}
