import { describe, it, expect } from 'vitest';
import { isCompressionLevel, VALID_COMPRESSION_LEVELS } from './compression-level.js';

describe('VALID_COMPRESSION_LEVELS', () => {
  it('lists the four levels in display order', () => {
    expect(VALID_COMPRESSION_LEVELS).toEqual(['max', 'high', 'medium', 'low']);
  });
});

describe('isCompressionLevel', () => {
  it('returns true for each valid level', () => {
    for (const level of VALID_COMPRESSION_LEVELS) {
      expect(isCompressionLevel(level)).toBe(true);
    }
  });

  it('returns false for an invalid string', () => {
    expect(isCompressionLevel('ultra')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isCompressionLevel(42)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isCompressionLevel(null)).toBe(false);
  });

  it('returns false for a boolean', () => {
    expect(isCompressionLevel(true)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isCompressionLevel(undefined)).toBe(false);
  });
});
