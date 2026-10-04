import { validateOAuthClientName, validateOAuthClientUri } from '../utils/index.js';

/**
 * Commander value parsers and collectors shared by the CLI subcommands.
 *
 * Each parser runs while Commander is still parsing argv, so an invalid
 * value fails before any config write or network activity, with a
 * message naming the flag that produced it.
 */

/**
 * Collects repeated `--header "K: V"` flags into a headers record.
 *
 * @param value - One `Key: Value` header string.
 * @param previous - Headers collected so far.
 * @returns The updated headers record.
 * @throws If the value does not contain a colon separator.
 */
export function collectHeaders(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const colonIdx = value.indexOf(':');
  if (colonIdx === -1) {
    throw new Error(`Invalid header format: "${value}". Expected "Key: Value".`);
  }
  const key = value.slice(0, colonIdx).trim();
  const val = value.slice(colonIdx + 1).trim();
  return { ...previous, [key]: val };
}

/**
 * Collects repeated `-e KEY=value` flags into an env record.
 *
 * @param value - One `KEY=value` pair.
 * @param previous - Environment variables collected so far.
 * @returns The updated env record.
 * @throws If the value does not contain an equals separator.
 */
export function collectEnv(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const eqIdx = value.indexOf('=');
  if (eqIdx === -1) {
    throw new Error(`Invalid env format: "${value}". Expected "KEY=value".`);
  }
  const key = value.slice(0, eqIdx);
  const val = value.slice(eqIdx + 1);
  return { ...previous, [key]: val };
}

/**
 * Collects repeated `--flag <value>` flags into an ordered string array.
 *
 * @param value - The next value for the repeated flag.
 * @param previous - Values collected so far.
 * @returns The updated array.
 */
export function collectStringArray(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Coerces a `--port` flag value into an integer. Throws on non-numeric
 * values so the user gets a clear error before any network activity.
 * Range validation is deferred to the command handlers.
 *
 * @param value - The raw `--port` value.
 * @returns The parsed integer.
 * @throws If the value is not an integer.
 */
export function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port)) {
    throw new Error(`--port must be an integer (got "${value}").`);
  }
  return port;
}

/**
 * Validates a `--client-name` flag value. Throws on empty values so the
 * user gets a clear error before any network activity. The value is
 * trimmed before it is written to the config or sent to the provider.
 *
 * @param value - The raw `--client-name` value.
 * @returns The trimmed client name.
 * @throws If the value is empty or whitespace-only.
 */
export function parseClientName(value: string): string {
  return validateOAuthClientName(value, '--client-name');
}

/**
 * Validates a `--client-uri` flag value as an absolute http(s) URL.
 * Throws on invalid values so the user gets a clear error before any
 * network activity.
 *
 * @param value - The raw `--client-uri` value.
 * @returns The trimmed client URI.
 * @throws If the value is not an absolute http(s) URL.
 */
export function parseClientUri(value: string): string {
  return validateOAuthClientUri(value, '--client-uri');
}
