import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { expandEnvField, ExpandEnvError } from './expand-env.js';

describe('expandEnvField', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear test variables
    delete process.env.TEST_VAR;
    delete process.env.EMPTY_VAR;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('passes through a string with no references unchanged', () => {
    expect(expandEnvField('hello world', 'test')).toBe('hello world');
  });

  it('expands ${VAR} from the environment', () => {
    process.env.TEST_VAR = 'expanded-value';
    expect(expandEnvField('prefix ${TEST_VAR} suffix', 'test')).toBe(
      'prefix expanded-value suffix',
    );
  });

  it('expands multiple references in one string', () => {
    process.env.A = 'alpha';
    process.env.B = 'beta';
    expect(expandEnvField('${A} and ${B}', 'test')).toBe('alpha and beta');
  });

  it('throws ExpandEnvError for undefined ${VAR} with no default', () => {
    expect(() => expandEnvField('${MISSING}', 'server "test" command')).toThrow(ExpandEnvError);
    try {
      expandEnvField('${MISSING}', 'server "test" command');
    } catch (e) {
      expect(e).toBeInstanceOf(ExpandEnvError);
      const err = e as ExpandEnvError;
      expect(err.variableName).toBe('MISSING');
      expect(err.context).toBe('server "test" command');
      expect(err.message).toContain('MISSING');
      expect(err.message).toContain('server "test" command');
    }
  });

  it('uses default value when ${VAR:-default} and VAR is unset', () => {
    expect(expandEnvField('${MISSING:-fallback}', 'test')).toBe('fallback');
  });

  it('uses env value over default when ${VAR:-default} and VAR is set', () => {
    process.env.TEST_VAR = 'from-env';
    expect(expandEnvField('${TEST_VAR:-fallback}', 'test')).toBe('from-env');
  });

  it('uses default when ${VAR:-default} and VAR is empty string', () => {
    process.env.TEST_VAR = '';
    expect(expandEnvField('${TEST_VAR:-fallback}', 'test')).toBe('fallback');
  });

  it('handles empty default value ${VAR:-}', () => {
    expect(expandEnvField('${MISSING:-}', 'test')).toBe('');
  });

  it('handles default containing special characters', () => {
    expect(expandEnvField('${MISSING:-http://example.com/path}', 'test')).toBe(
      'http://example.com/path',
    );
  });

  it('handles default containing colons and hyphens', () => {
    expect(expandEnvField('${MISSING:-foo:-bar:baz}', 'test')).toBe('foo:-bar:baz');
  });
});
