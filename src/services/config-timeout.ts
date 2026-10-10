import type { ServerTimeoutInput } from '../utils/types.js';

/** Keys recognized inside a server entry's `timeout` block. */
const TIMEOUT_KEYS = ['startup', 'execution'] as const;

/**
 * Validates the optional `timeout` block on a server entry.
 *
 * Both keys are optional positive integers in milliseconds; unknown keys
 * are ignored, like the rest of the loader. `undefined` means the block
 * is absent and the caller resolves env/defaults instead.
 *
 * @param serverName - Server name for error messages.
 * @param raw - The raw `timeout` value from the server entry.
 * @returns The validated per-server overrides, or undefined when absent.
 * @throws If the block is not a plain object or a present `startup` /
 *   `execution` value is not a positive integer.
 */
export function parseTimeoutBlock(
  serverName: string,
  raw: unknown,
): ServerTimeoutInput | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Server "${serverName}": timeout must be an object`);
  }
  const block = raw as Record<string, unknown>;
  const parsed: ServerTimeoutInput = {};
  for (const key of TIMEOUT_KEYS) {
    const value = block[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`Server "${serverName}": timeout.${key} must be a positive integer`);
    }
    parsed[key] = value;
  }
  return parsed;
}
