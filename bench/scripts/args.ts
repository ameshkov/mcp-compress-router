/**
 * Command-line argument helpers for the benchmark scripts.
 *
 * Both `pnpm <script> -- <args>` and `docker compose run <service> --
 * <args>` forward the `--` separator to the process, so it must be
 * dropped before option parsing.
 */

/**
 * Removes `--` separators from a script argument list.
 *
 * @param argv - The raw script arguments (`process.argv.slice(2)`).
 * @returns The arguments without any `--` entries.
 */
export function scriptArgs(argv: string[]): string[] {
  return argv.filter((arg) => arg !== '--');
}
