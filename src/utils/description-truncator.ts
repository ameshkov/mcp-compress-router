/**
 * Truncates a tool description to the first sentence (text up to the
 * first `.`), capped at 10 words. When the first sentence exceeds 10
 * words, only the first 10 are kept and `...` (three ASCII dots) is
 * appended. When the description is absent or empty, returns an empty
 * string. No failure modes — malformed input always yields an empty
 * string.
 *
 * Used by the catalog text renderer at the `medium` compression level.
 * This is distinct from the character-based `truncateDescription` in
 * `src/cli/tools-command.ts`, which serves the CLI table layout.
 *
 * @param description - The raw tool description, or undefined.
 * @returns The truncated first-sentence snippet (possibly empty).
 */
export function truncateToFirstSentence(description: string | undefined): string {
  if (description === undefined || description.length === 0) {
    return '';
  }
  const firstSentence = description.split('.')[0].trim();
  const words = firstSentence.length === 0 ? [] : firstSentence.split(/\s+/);
  if (words.length === 0) {
    return '';
  }
  if (words.length <= 10) {
    return words.join(' ');
  }
  return `${words.slice(0, 10).join(' ')}...`;
}
