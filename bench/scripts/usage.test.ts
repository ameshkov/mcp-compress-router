import { describe, expect, it } from 'vitest';
import { parseUsageJson } from './usage.js';

describe('ccusage JSON parsing', () => {
  it('reads the current focused report shape', () => {
    const totals = parseUsageJson({
      sessions: [],
      totals: {
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationTokens: 3,
        cacheReadTokens: 4,
        totalTokens: 19,
        totalCost: 0.5,
      },
    });
    expect(totals).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cacheCreationTokens: 3,
      cacheReadTokens: 4,
      totalTokens: 19,
      totalCost: 0.5,
    });
  });

  it('reads the legacy summary shape', () => {
    const totals = parseUsageJson({
      type: 'session',
      data: [],
      summary: {
        totalInputTokens: 100,
        totalOutputTokens: 20,
        totalCacheCreationTokens: 30,
        totalCacheReadTokens: 40,
        totalTokens: 190,
        totalCostUSD: 1.25,
      },
    });
    expect(totals).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationTokens: 30,
      cacheReadTokens: 40,
      totalTokens: 190,
      totalCost: 1.25,
    });
  });

  it('sums legacy rows when no summary exists', () => {
    const totals = parseUsageJson({
      data: [
        {
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationTokens: 3,
          cacheReadTokens: 4,
          totalTokens: 10,
          costUSD: 0.1,
        },
        {
          inputTokens: 5,
          outputTokens: 6,
          cacheCreationTokens: 7,
          cacheReadTokens: 8,
          totalTokens: 26,
          costUSD: 0.2,
        },
      ],
    });
    expect(totals).toEqual({
      inputTokens: 6,
      outputTokens: 8,
      cacheCreationTokens: 10,
      cacheReadTokens: 12,
      totalTokens: 36,
      totalCost: 0.30000000000000004,
    });
  });

  it('sums current session rows when no totals exist', () => {
    const totals = parseUsageJson({
      sessions: [
        {
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationTokens: 3,
          cacheReadTokens: 4,
          totalTokens: 10,
          totalCost: 0.1,
        },
        {
          inputTokens: 5,
          outputTokens: 6,
          cacheCreationTokens: 7,
          cacheReadTokens: 8,
          totalTokens: 26,
          totalCost: 0.2,
        },
      ],
    });
    expect(totals).toEqual({
      inputTokens: 6,
      outputTokens: 8,
      cacheCreationTokens: 10,
      cacheReadTokens: 12,
      totalTokens: 36,
      totalCost: 0.30000000000000004,
    });
  });

  it('sums older single-session rows when no totals exist', () => {
    const totals = parseUsageJson({
      session: [
        {
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationTokens: 3,
          cacheReadTokens: 4,
          totalTokens: 10,
          totalCost: 0.1,
        },
      ],
    });
    expect(totals).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationTokens: 3,
      cacheReadTokens: 4,
      totalTokens: 10,
      totalCost: 0.1,
    });
  });

  it('returns undefined for documents without totals', () => {
    expect(parseUsageJson(null)).toBeUndefined();
    expect(parseUsageJson('not a report')).toBeUndefined();
    expect(parseUsageJson({})).toBeUndefined();
    expect(parseUsageJson({ totals: { inputTokens: 1 } })).toBeUndefined();
  });
});
