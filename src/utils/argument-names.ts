/**
 * Extracts ordered argument names from a tool's `inputSchema`.
 *
 * Reads `inputSchema.properties` keys in definition order. Returns an
 * empty array when the schema is undefined, has no `properties` key,
 * or has a non-object `properties` value (including null). No failure
 * modes — malformed input always yields an empty array.
 *
 * @param inputSchema - The JSON Schema object from a tool descriptor.
 * @returns Ordered argument names (possibly empty).
 */
export function extractArgumentNames(inputSchema: Record<string, unknown> | undefined): string[] {
  if (inputSchema === undefined) {
    return [];
  }
  const properties = inputSchema.properties;
  if (properties === undefined || properties === null || typeof properties !== 'object') {
    return [];
  }
  return Object.keys(properties as Record<string, unknown>);
}
