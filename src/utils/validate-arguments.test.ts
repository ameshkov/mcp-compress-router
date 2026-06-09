import { describe, it, expect } from 'vitest';
import { validateArguments } from './validate-arguments.js';

describe('validateArguments', () => {
  const echoSchema = {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The message to echo.' },
    },
    required: ['message'],
  };

  const addSchema = {
    type: 'object',
    properties: {
      a: { type: 'number' },
      b: { type: 'number' },
    },
    required: ['a', 'b'],
  };

  it('returns valid for correct arguments', () => {
    const result = validateArguments({ message: 'hello' }, echoSchema);
    expect(result).toEqual({ valid: true });
  });

  it('returns valid when optional properties are omitted', () => {
    const schema = {
      type: 'object',
      properties: {
        x: { type: 'string' },
        y: { type: 'number' },
      },
    };
    const result = validateArguments({ x: 'hi' }, schema);
    expect(result).toEqual({ valid: true });
  });

  it('returns valid when schema has no properties or required', () => {
    const result = validateArguments({ anything: 123 }, { type: 'object' });
    expect(result).toEqual({ valid: true });
  });

  it('returns valid when top-level type is not object', () => {
    const result = validateArguments({ x: 1 }, { type: 'array' });
    expect(result).toEqual({ valid: true });
  });

  it('detects missing required argument', () => {
    const result = validateArguments({}, echoSchema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('Missing required'))).toBe(true);
      expect(result.errors.some((e) => e.includes('"message"'))).toBe(true);
    }
  });

  it('detects missing required argument (add with only a)', () => {
    const result = validateArguments({ a: 5 }, addSchema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('"b"'))).toBe(true);
    }
  });

  it('detects wrong type (string instead of number)', () => {
    const result = validateArguments({ a: 'not-a-number', b: 3 }, addSchema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('"a"') && e.includes('expected number'))).toBe(
        true,
      );
    }
  });

  it('detects unknown argument', () => {
    const result = validateArguments({ message: 'hi', extra: true }, echoSchema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((e) => e.includes('Unknown argument') && e.includes('"extra"')),
      ).toBe(true);
    }
  });

  it('includes expected shape summary in error output', () => {
    const result = validateArguments({}, echoSchema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const lastError = result.errors[result.errors.length - 1];
      expect(lastError).toContain('Expected shape');
      expect(lastError).toContain('message');
    }
  });

  it('skips type check for undefined optional property', () => {
    const schema = {
      type: 'object',
      properties: {
        x: { type: 'string' },
      },
    };
    // Providing undefined for an optional property should not error
    const result = validateArguments({ x: undefined }, schema);
    expect(result).toEqual({ valid: true });
  });

  it('reports multiple errors at once', () => {
    const result = validateArguments({ x: 'wrong' }, addSchema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      // Missing required: a, b
      // Unknown argument: x
      expect(result.errors.filter((e) => e.includes('Missing required'))).toHaveLength(2);
      expect(result.errors.some((e) => e.includes('Unknown argument'))).toBe(true);
    }
  });

  it('handles integer type correctly', () => {
    const schema = {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    };
    expect(validateArguments({ count: 5 }, schema)).toEqual({ valid: true });
    const result = validateArguments({ count: 5.5 }, schema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('expected integer'))).toBe(true);
    }
  });

  it('handles boolean type correctly', () => {
    const schema = {
      type: 'object',
      properties: { flag: { type: 'boolean' } },
      required: ['flag'],
    };
    expect(validateArguments({ flag: true }, schema)).toEqual({ valid: true });
    const result = validateArguments({ flag: 'yes' }, schema);
    expect(result.valid).toBe(false);
  });

  it('handles array type correctly', () => {
    const schema = {
      type: 'object',
      properties: { items: { type: 'array' } },
      required: ['items'],
    };
    expect(validateArguments({ items: [1, 2] }, schema)).toEqual({
      valid: true,
    });
    const result = validateArguments({ items: 'not-array' }, schema);
    expect(result.valid).toBe(false);
  });

  it('coerces string "true"/"false" to boolean', () => {
    const schema = {
      type: 'object',
      properties: { flag: { type: 'boolean' } },
      required: ['flag'],
    };
    const args = { flag: 'true' };
    expect(validateArguments(args, schema)).toEqual({ valid: true });
    expect(args.flag).toBe(true);

    const args2 = { flag: 'false' };
    expect(validateArguments(args2, schema)).toEqual({ valid: true });
    expect(args2.flag).toBe(false);
  });

  it('coerces numeric strings to number', () => {
    const schema = {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
    };
    const args = { value: '42' };
    expect(validateArguments(args, schema)).toEqual({ valid: true });
    expect(args.value).toBe(42);

    const args2 = { value: '3.14' };
    expect(validateArguments(args2, schema)).toEqual({ valid: true });
    expect(args2.value).toBe(3.14);
  });

  it('coerces numeric strings to integer', () => {
    const schema = {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    };
    const args = { count: '7' };
    expect(validateArguments(args, schema)).toEqual({ valid: true });
    expect(args.count).toBe(7);
  });

  it('rejects non-coercible string for boolean field', () => {
    const schema = {
      type: 'object',
      properties: { flag: { type: 'boolean' } },
      required: ['flag'],
    };
    const result = validateArguments({ flag: 'yes' }, schema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('expected boolean'))).toBe(true);
    }
  });

  it('rejects non-numeric string for number field', () => {
    const schema = {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
    };
    const result = validateArguments({ value: 'abc' }, schema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('expected number'))).toBe(true);
    }
  });

  it('rejects partially-numeric string for number field', () => {
    const schema = {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
    };
    const result = validateArguments({ value: '42abc' }, schema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('expected number'))).toBe(true);
    }
  });

  it('rejects empty string for number field', () => {
    const schema = {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
    };
    const result = validateArguments({ value: '' }, schema);
    expect(result.valid).toBe(false);
  });

  it('rejects whitespace-only string for number field', () => {
    const schema = {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
    };
    const result = validateArguments({ value: '  ' }, schema);
    expect(result.valid).toBe(false);
  });

  it('does not coerce strings for object fields', () => {
    const schema = {
      type: 'object',
      properties: { data: { type: 'object' } },
      required: ['data'],
    };
    const result = validateArguments({ data: 'not-an-object' }, schema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('expected object'))).toBe(true);
    }
  });
});
