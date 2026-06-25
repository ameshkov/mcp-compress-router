import picomatch from 'picomatch';

/**
 * Validates that a glob pattern compiles under picomatch with strict
 * bracket handling, the same option the Tool Filter uses for matching.
 *
 * Throws when the pattern is malformed (e.g. unclosed bracket or brace).
 * Used by the Config Loader and the `add` CLI command so invalid globs
 * are rejected at the earliest possible point with a consistent error.
 *
 * @param pattern - Glob pattern to validate.
 * @throws If picomatch rejects the pattern.
 * @public
 */
export function validateGlobPattern(pattern: string): void {
  try {
    picomatch.makeRe(pattern, { strictBrackets: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid glob pattern "${pattern}": ${reason}`);
  }
}
