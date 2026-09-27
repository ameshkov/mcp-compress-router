/**
 * Explains why a server description is important and what it should
 * contain.
 *
 * Embedded verbatim by the `add` command (`add-command.ts`), the entry
 * point that requires a description. Config loading accepts entries
 * without one for backward compatibility, so the router still starts.
 */
export const SERVER_DESCRIPTION_GUIDANCE =
  'A short (1-2 sentences at most) description of the MCP server is required: ' +
  'it helps the model understand what the server is and why the model could need it, ' +
  'for example "GitHub API tools for browsing repositories, issues, and pull requests".';

/**
 * Normalizes a raw server description to a single line.
 *
 * Leading and trailing whitespace is trimmed and interior whitespace
 * runs are collapsed to single spaces, so a multi-line description (a
 * hand-edited config entry or a shell `--description` value) cannot
 * render as extra catalog sections. A description is strongly
 * recommended but optional at the config level; the `add` command
 * enforces a non-empty one.
 *
 * Shared by the `add` command (the writer) and config loading (the
 * reader) so both apply exactly the same rule.
 *
 * @param value - The raw description value; any type is accepted.
 * @returns The normalized description, or undefined when the value is
 *   not a string or contains only whitespace.
 */
export function normalizeDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length > 0 ? normalized : undefined;
}
