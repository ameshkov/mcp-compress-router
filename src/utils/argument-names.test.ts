import { describe, it, expect } from 'vitest';
import { extractArgumentNames } from './argument-names.js';

describe('extractArgumentNames', () => {
  it('returns property keys in definition order', () => {
    const schema = {
      type: 'object',
      properties: { url: { type: 'string' }, timeout: { type: 'number' } },
    };
    expect(extractArgumentNames(schema)).toEqual(['url', 'timeout']);
  });

  it('returns an empty array for an empty properties object', () => {
    expect(extractArgumentNames({ type: 'object', properties: {} })).toEqual([]);
  });

  it('returns an empty array when properties is absent', () => {
    expect(extractArgumentNames({ type: 'object' })).toEqual([]);
  });

  it('returns an empty array when properties is a non-object', () => {
    expect(extractArgumentNames({ type: 'object', properties: 'oops' })).toEqual([]);
  });

  it('returns an empty array when properties is null', () => {
    expect(extractArgumentNames({ type: 'object', properties: null })).toEqual([]);
  });

  it('returns an empty array for undefined input', () => {
    expect(extractArgumentNames(undefined)).toEqual([]);
  });

  it('returns a single property key', () => {
    const schema = { type: 'object', properties: { message: { type: 'string' } } };
    expect(extractArgumentNames(schema)).toEqual(['message']);
  });
});
