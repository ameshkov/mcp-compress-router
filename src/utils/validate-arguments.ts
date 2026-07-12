/**
 * Result of argument validation against a JSON Schema.
 */
type ValidationResult = { valid: true } | { valid: false; errors: string[] };

// Allowed values for JSON Schema "type" in MCP tool input schemas.
type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

const TYPE_CHECKERS: Record<JsonType, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && !Number.isNaN(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
};

/**
 * Coerces a string value to the target JSON Schema type.
 *
 * Handles common LLM mistakes where `"true"` / `"false"` is passed for
 * a boolean field or `"42"` / `"3.14"` is passed for a number field.
 * Returns the coerced value, or the original value if coercion is
 * not applicable.
 *
 * @param value - The raw argument value (may be a string).
 * @param targetType - The expected JSON Schema type.
 * @returns The coerced value or the original.
 */
function coerceValue(value: unknown, targetType: JsonType): unknown {
  if (typeof value !== 'string') return value;

  switch (targetType) {
    case 'boolean': {
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    }
    case 'number':
    case 'integer': {
      // Reject empty strings and whitespace-only strings
      if (value.trim() === '') return value;
      const num = Number(value);
      if (!Number.isFinite(num)) return value;
      // Only coerce if the string is a complete numeric representation
      // (e.g., "42" → 42, "3.14" → 3.14, but "42abc" stays a string)
      if (String(num) === value.trim()) return num;
      return value;
    }
    default:
      return value;
  }
}

/**
 * Validates a single property value against its schema definition.
 *
 * Checks type correctness and coerces string values to the expected type
 * when possible. Mutates `args` in-place on successful coercion and
 * pushes error messages into `errors` on validation failures.
 *
 * @param key - The property name.
 * @param value - The raw value for the property.
 * @param propSchema - The JSON Schema definition for this property.
 * @param required - List of required property names.
 * @param args - The arguments object (mutated on coercion).
 * @param errors - Accumulator for validation error messages.
 */
function checkProperty(
  key: string,
  value: unknown,
  propSchema: Record<string, unknown>,
  required: string[],
  args: Record<string, unknown>,
  errors: string[],
): void {
  // If the value is missing (undefined) but not required, skip type check
  if (value === undefined && !required.includes(key)) {
    return;
  }

  const expectedType = propSchema.type as JsonType | undefined;
  if (!expectedType) return;

  // Coerce string values to the expected type (e.g., "true" → boolean,
  // "42" → number) to accommodate common LLM encoding mistakes.
  const coerced = coerceValue(value, expectedType);
  if (coerced !== value) {
    args[key] = coerced;
  }
  if (!TYPE_CHECKERS[expectedType]?.(coerced)) {
    const actualType = Array.isArray(coerced) ? 'array' : typeof coerced;
    errors.push(`Wrong type for "${key}": expected ${expectedType}, got ${actualType}`);
  }
}

/**
 * Builds a human-readable summary of the expected schema shape
 * for inclusion in validation error messages.
 *
 * @param properties - The `properties` map from the input schema.
 * @param required - List of required property names.
 * @returns A formatted string describing each property and its type.
 */
function summarizeSchema(
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): string {
  const propDescriptions = Object.keys(properties)
    .map((k) => {
      const prop = properties[k];
      const req = required.includes(k) ? ' (required)' : ' (optional)';
      return `  - ${k}: ${prop.type ?? 'any'}${req}`;
    })
    .join('\n');
  return `Expected shape:\n${propDescriptions}`;
}

/**
 * Validates a plain arguments object against a JSON Schema
 * `inputSchema` from a downstream MCP tool.
 *
 * Handles `type: "object"` schemas with `properties` (type checks),
 * `required` (presence checks), and extra/unknown property detection.
 * Returns descriptive error messages suitable for LLM self-correction.
 *
 * Coerces string values to the expected type when possible
 * (e.g., `"true"` → `true`, `"42"` → `42`). This accommodates common
 * LLM encoding mistakes where string representations of booleans or
 * numbers are passed instead of their JSON-native equivalents.
 * Mutates the `args` object in-place when coercion is applied, so the
 * caller receives properly-typed values for downstream forwarding.
 *
 * @param args - The arguments object to validate. May be mutated.
 * @param inputSchema - The JSON Schema object from the tool descriptor.
 * @returns A validation result.
 */
export function validateArguments(
  args: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
): ValidationResult {
  const errors: string[] = [];

  // Top-level must be type "object" (MCP tool convention)
  if (inputSchema.type !== 'object') {
    // Schema is not an object schema — skip validation, assume valid
    return { valid: true };
  }

  const required: string[] = (
    Array.isArray(inputSchema.required) ? inputSchema.required : []
  ) as string[];
  const properties = (inputSchema.properties as Record<string, Record<string, unknown>>) ?? {};

  if (Object.keys(properties).length === 0 && required.length === 0) {
    // No constraints — any args accepted
    return { valid: true };
  }

  // Check required
  for (const key of required) {
    if (!(key in args)) {
      errors.push(`Missing required argument: "${key}"`);
    }
  }

  // Check types of provided values
  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key];
    if (!propSchema) {
      if (Object.keys(properties).length > 0) {
        // Provided a key not listed in properties
        const known = Object.keys(properties).join(', ');
        errors.push(`Unknown argument: "${key}". Expected arguments: ${known}`);
      }
      continue;
    }
    checkProperty(key, value, propSchema, required, args, errors);
  }

  if (errors.length > 0) {
    return { valid: false, errors: [...errors, summarizeSchema(properties, required)] };
  }

  return { valid: true };
}
