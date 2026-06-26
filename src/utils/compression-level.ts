import type { CompressionLevel } from './types.js';

/**
 * Valid `compressionLevel` values, in the order used for error messages
 * and documentation.
 */
export const VALID_COMPRESSION_LEVELS: readonly CompressionLevel[] = [
  'max',
  'high',
  'medium',
  'low',
];

/**
 * Type guard confirming a value is one of the four valid
 * {@link CompressionLevel} strings (`max`, `high`, `medium`, `low`).
 *
 * Used by both the Config Loader (startup validation) and the `add` CLI
 * command (flag validation) so both check against a single source of
 * truth.
 *
 * @param value - Any value read from config or a CLI flag.
 * @returns True when `value` is a string and one of the four valid levels.
 */
export function isCompressionLevel(value: unknown): value is CompressionLevel {
  return (
    typeof value === 'string' && (VALID_COMPRESSION_LEVELS as readonly string[]).includes(value)
  );
}
