import { describe, expect, it } from 'vitest';
import { runStatus } from './run-status.js';
import type { RunSummary } from './run-summary.js';

/**
 * Builds a run summary for status rendering.
 *
 * @param overrides - Fields to override on the summary.
 * @returns A complete run summary.
 */
function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'claude-direct-test',
    agent: 'claude',
    mode: 'direct',
    model: 'test-model',
    startedAt: '2026-09-22T10:00:00.000Z',
    finishedAt: '2026-09-22T10:10:00.000Z',
    exitCode: 0,
    timedOut: false,
    durationMs: 600_000,
    steps: 5,
    sessionID: 'session',
    mcpInvocations: 0,
    usage: {
      source: 'claude',
      available: true,
      totals: {
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 12,
        totalCost: 0.01,
      },
    },
    ...overrides,
  };
}

describe('run status labels', () => {
  it('reports a completed measured run as ok', () => {
    expect(runStatus(summary())).toBe('ok');
  });

  it('reports a timed-out run as timeout', () => {
    expect(runStatus(summary({ timedOut: true }))).toBe('timeout');
  });

  it('reports a signalled run as killed', () => {
    expect(runStatus(summary({ exitCode: null }))).toBe('killed');
  });

  it('reports a failed run with its exit code', () => {
    expect(runStatus(summary({ exitCode: 2 }))).toBe('exit 2');
  });

  it('reports a successful run without usage data as no usage', () => {
    expect(runStatus(summary({ usage: { source: 'claude', available: false } }))).toBe('no usage');
  });
});
