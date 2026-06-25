import { describe, it, expect } from 'vitest';
import { validateGlobPattern } from './validate-glob.js';

describe('validateGlobPattern', () => {
  it('accepts a literal tool name', () => {
    expect(() => validateGlobPattern('list_issues')).not.toThrow();
  });

  it('accepts wildcard patterns', () => {
    expect(() => validateGlobPattern('file_*')).not.toThrow();
    expect(() => validateGlobPattern('*_read')).not.toThrow();
    expect(() => validateGlobPattern('f?le')).not.toThrow();
  });

  it('accepts brace and character-class patterns', () => {
    expect(() => validateGlobPattern('{a,b}')).not.toThrow();
    expect(() => validateGlobPattern('[abc]')).not.toThrow();
  });

  it('throws on an unclosed bracket', () => {
    expect(() => validateGlobPattern('[unclosed')).toThrow(/\[unclosed/);
  });

  it('throws on an unclosed brace', () => {
    expect(() => validateGlobPattern('{a,b')).toThrow(/\{a,b/);
  });

  it('includes the offending pattern in the error message', () => {
    expect(() => validateGlobPattern('[bad')).toThrow(/\[bad/);
  });
});
