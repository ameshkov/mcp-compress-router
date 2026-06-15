import { describe, it, expect } from 'vitest';
import { parseJsonc } from './parse-jsonc.js';

describe('parseJsonc', () => {
  it('parses standard JSON', () => {
    const result = parseJsonc('{"foo": "bar", "num": 42}', 'test.json');
    expect(result).toEqual({ foo: 'bar', num: 42 });
  });

  it('parses JSONC with // line comments', () => {
    const text = `
      {
        // This is a comment
        "foo": "bar"
      }
    `;
    const result = parseJsonc(text, 'test.jsonc');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('parses JSONC with /* block comments */', () => {
    const text = `
      {
        /* block comment */
        "foo": "bar"
      }
    `;
    const result = parseJsonc(text, 'test.jsonc');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('parses JSONC with trailing commas', () => {
    const text = `
      {
        "foo": "bar",
        "num": 42,
      }
    `;
    const result = parseJsonc(text, 'test.jsonc');
    expect(result).toEqual({ foo: 'bar', num: 42 });
  });

  it('parses JSONC with mixed comments and trailing commas', () => {
    const text = `
      {
        // Server config
        "servers": [
          { "name": "alpha", "port": 8080, },
          /* second server */
          { "name": "beta", "port": 9090, },
        ],
      }
    `;
    const result = parseJsonc(text, 'config.jsonc');
    expect(result).toEqual({
      servers: [
        { name: 'alpha', port: 8080 },
        { name: 'beta', port: 9090 },
      ],
    });
  });

  it('throws on empty string', () => {
    expect(() => parseJsonc('', 'test.json')).toThrow('Failed to parse');
  });

  it('throws on whitespace-only string', () => {
    expect(() => parseJsonc('   ', 'test.json')).toThrow('Failed to parse');
  });

  it('parses null literal successfully (caller validates structure)', () => {
    const result = parseJsonc('null', 'test.json');
    expect(result).toBeNull();
  });

  it('parses a JSON array successfully (caller validates structure)', () => {
    const result = parseJsonc('[1, 2, 3]', 'test.json');
    expect(result).toEqual([1, 2, 3]);
  });
});
