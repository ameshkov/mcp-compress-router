import { describe, it, expect } from 'vitest';
import { truncateToFirstSentence } from './description-truncator.js';

describe('truncateToFirstSentence', () => {
  it('returns the first sentence without the period when under 10 words', () => {
    expect(
      truncateToFirstSentence('Fetches a URL and returns the raw content. Supports timeout.'),
    ).toBe('Fetches a URL and returns the raw content');
  });

  it('truncates to 10 words with ASCII ellipsis when the first sentence exceeds 10 words', () => {
    expect(
      truncateToFirstSentence(
        'This particular tool fetches data from a remote URL endpoint with optional timeout.',
      ),
    ).toBe('This particular tool fetches data from a remote URL endpoint...');
  });

  it('returns an empty string for undefined input', () => {
    expect(truncateToFirstSentence(undefined)).toBe('');
  });

  it('returns an empty string for an empty string input', () => {
    expect(truncateToFirstSentence('')).toBe('');
  });

  it('returns the whole string when there is no period and under 10 words', () => {
    expect(truncateToFirstSentence('No period in this description')).toBe(
      'No period in this description',
    );
  });

  it('returns only the first sentence when multiple sentences are present', () => {
    expect(truncateToFirstSentence('First sentence here. Second one.')).toBe('First sentence here');
  });

  it('returns a single word without a period or ellipsis', () => {
    expect(truncateToFirstSentence('Short.')).toBe('Short');
  });

  it('returns up to 10 words without an ellipsis at exactly 10 words', () => {
    const ten = 'one two three four five six seven eight nine ten.';
    expect(truncateToFirstSentence(ten)).toBe('one two three four five six seven eight nine ten');
  });

  it('truncates with an ellipsis at exactly 11 words', () => {
    const eleven = 'one two three four five six seven eight nine ten eleven.';
    expect(truncateToFirstSentence(eleven)).toBe(
      'one two three four five six seven eight nine ten...',
    );
  });

  it('returns an empty string when the description is only a period', () => {
    expect(truncateToFirstSentence('.')).toBe('');
  });
});
