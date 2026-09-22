import process from 'node:process';
import { readPositiveIntEnv } from './timeout.js';

/**
 * Default maximum character length of the rendered `get_tool_schema`
 * description before the router auto-degrades the catalog for
 * length-limited clients. Matches Claude Code's 2048-character
 * tool-description cap: descriptions longer than this are truncated by
 * the client and break routing.
 *
 * @internal Exported for tests only; not part of the public module API.
 */
export const DEFAULT_DYNAMIC_LIMIT_MAX_SIZE = 2048;

/**
 * Client names treated as length-limited by default. Claude Code is the
 * known client that truncates tool descriptions at
 * {@link DEFAULT_DYNAMIC_LIMIT_MAX_SIZE} characters.
 *
 * @internal Exported for tests only; not part of the public module API.
 */
export const DEFAULT_DYNAMIC_LIMIT_CLIENTS: readonly string[] = ['claude-code'];

/**
 * Resolves the description-length cap used by {@link exceedsDynamicLimit}.
 *
 * Override with `MCP_COMPRESS_ROUTER_DYNAMIC_LIMIT_MAX_SIZE` (a positive
 * integer); unset or invalid values fall back to
 * {@link DEFAULT_DYNAMIC_LIMIT_MAX_SIZE}.
 *
 * @internal Exported for tests only; not part of the public module API.
 *
 * @returns The maximum description length in characters.
 */
export function getDynamicLimitMaxSize(): number {
  return (
    readPositiveIntEnv('MCP_COMPRESS_ROUTER_DYNAMIC_LIMIT_MAX_SIZE') ??
    DEFAULT_DYNAMIC_LIMIT_MAX_SIZE
  );
}

/**
 * Resolves the set of client names whose tool descriptions are
 * length-limited.
 *
 * Override with `MCP_COMPRESS_ROUTER_DYNAMIC_LIMIT_CLIENTS`, a
 * comma-separated list of client names (matched case-insensitively).
 * When the variable is unset, {@link DEFAULT_DYNAMIC_LIMIT_CLIENTS} is
 * used; when it is set but empty (or only whitespace/commas), the list
 * is empty and auto-degradation is disabled entirely.
 *
 * @internal Exported for tests only; not part of the public module API.
 *
 * @returns The configured client names, normalized to lower case.
 */
export function getDynamicLimitClients(): string[] {
  const raw = process.env.MCP_COMPRESS_ROUTER_DYNAMIC_LIMIT_CLIENTS;
  if (raw === undefined) {
    return [...DEFAULT_DYNAMIC_LIMIT_CLIENTS];
  }
  return raw
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
}

/**
 * Reports whether `clientName` belongs to the dynamic-limit client set.
 *
 * @internal Exported for tests only; not part of the public module API.
 *
 * @param clientName - The MCP client name from `initialize`, if any.
 * @returns True when the client is configured as length-limited.
 */
export function isDynamicLimitClient(clientName: string | undefined): boolean {
  if (clientName === undefined) {
    return false;
  }
  return getDynamicLimitClients().includes(clientName.trim().toLowerCase());
}

/**
 * Reports whether the rendered `get_tool_schema` description exceeds
 * the configured cap for the given client.
 *
 * The router calls this on the configured render to decide whether to
 * re-render the catalog at `max`, and again on the degraded render to
 * detect that the cap is still exceeded. The forced `max` render only
 * lowers compression levels — server descriptions and status lines are
 * always included — so a catalog with a long server description can
 * stay over the cap; the router logs a warning in that case rather
 * than re-rendering again.
 *
 * Only configured length-limited clients can exceed the limit, and the
 * check is strict: a description exactly at the cap is safe, matching
 * Claude Code, which truncates only when `length > 2048`.
 *
 * @param description - The rendered `get_tool_schema` description.
 * @param clientName - The MCP client name from `initialize`, if any.
 * @returns True when the client is length-limited and the description
 *   is over the cap.
 */
export function exceedsDynamicLimit(description: string, clientName: string | undefined): boolean {
  if (!isDynamicLimitClient(clientName)) {
    return false;
  }
  return description.length > getDynamicLimitMaxSize();
}
