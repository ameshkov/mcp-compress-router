import { describe, expect, it } from 'vitest';
import { SERVER_DESCRIPTION_GUIDANCE, normalizeDescription } from './description-guidance.js';

describe('SERVER_DESCRIPTION_GUIDANCE', () => {
  it('states the length guidance and gives an example', () => {
    expect(SERVER_DESCRIPTION_GUIDANCE).toContain('1-2 sentences');
    expect(SERVER_DESCRIPTION_GUIDANCE).toContain('for example');
  });

  it('stays a single line so it reads well inside an error message', () => {
    expect(SERVER_DESCRIPTION_GUIDANCE).not.toContain('\n');
  });
});

describe('normalizeDescription', () => {
  it('returns undefined for a missing or non-string value', () => {
    expect(normalizeDescription(undefined)).toBeUndefined();
    expect(normalizeDescription(42)).toBeUndefined();
  });

  it('returns undefined for an empty or whitespace-only value', () => {
    expect(normalizeDescription('')).toBeUndefined();
    expect(normalizeDescription(' \n\t ')).toBeUndefined();
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeDescription('  Padded description  ')).toBe('Padded description');
  });

  it('collapses interior whitespace so the description stays one line', () => {
    expect(normalizeDescription('First line.\n\n## fake-server   Second line.')).toBe(
      'First line. ## fake-server Second line.',
    );
  });

  it('leaves an already-normalized description unchanged', () => {
    expect(normalizeDescription('GitHub tools for issues and pull requests.')).toBe(
      'GitHub tools for issues and pull requests.',
    );
  });
});
