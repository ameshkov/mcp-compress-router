import { describe, expect, it } from 'vitest';
import type { BenchAgent, BenchMode } from './configs/types.js';
import { buildComparisons } from './comparison.js';
import type { RunSummary } from './run-summary.js';

/**
 * Builds a run summary with the given totals.
 *
 * @param agent - The coding agent.
 * @param mode - The benchmark mode.
 * @param totalTokens - Total token count for the run.
 * @param totalCost - Total cost for the run.
 * @param steps - Number of LLM turns for the run.
 * @param overrides - Fields to override on the finished summary.
 * @returns A complete run summary.
 */
function summary(
  agent: BenchAgent,
  mode: BenchMode,
  totalTokens: number,
  totalCost: number,
  steps: number,
  overrides: Partial<RunSummary> = {},
): RunSummary {
  return {
    runId: `${agent}-${mode}-test`,
    agent,
    mode,
    model: 'test-model',
    startedAt: '2026-09-22T10:00:00.000Z',
    finishedAt: '2026-09-22T10:10:00.000Z',
    exitCode: 0,
    timedOut: false,
    durationMs: 600_000,
    steps,
    sessionID: 'session',
    mcpInvocations: 0,
    usage: {
      source: agent,
      available: true,
      totals: {
        inputTokens: totalTokens,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens,
        totalCost,
      },
    },
    ...overrides,
  };
}

describe('router-vs-direct comparisons', () => {
  it('computes the delta for an agent with both modes', () => {
    const comparisons = buildComparisons([
      summary('claude', 'direct', 1_000, 1, 20),
      summary('claude', 'router', 400, 0.4, 10),
    ]);
    expect(comparisons).toEqual([
      {
        agent: 'claude',
        directSteps: 20,
        routerSteps: 10,
        stepDeltaPct: -50,
        directTokens: 1_000,
        routerTokens: 400,
        tokenDeltaPct: -60,
        directTokensPerStep: 50,
        routerTokensPerStep: 40,
        tokensPerStepDeltaPct: -20,
        directInputTokens: 1_000,
        routerInputTokens: 400,
        directCacheReadTokens: 0,
        routerCacheReadTokens: 0,
        directCacheCreationTokens: 0,
        routerCacheCreationTokens: 0,
        directOutputTokens: 0,
        routerOutputTokens: 0,
        directCost: 1,
        routerCost: 0.4,
        costDeltaPct: expect.closeTo(-60, 5),
      },
    ]);
  });

  it('averages repeated runs per mode', () => {
    const comparisons = buildComparisons([
      summary('codex', 'direct', 500, 0.5, 10),
      summary('codex', 'direct', 700, 0.7, 10),
      summary('codex', 'router', 300, 0.3, 10),
    ]);
    expect(comparisons[0]?.directTokens).toBe(600);
    expect(comparisons[0]?.routerTokens).toBe(300);
    expect(comparisons[0]?.tokenDeltaPct).toBe(-50);
    expect(comparisons[0]?.directSteps).toBe(10);
    expect(comparisons[0]?.routerSteps).toBe(10);
    expect(comparisons[0]?.stepDeltaPct).toBe(0);
    expect(comparisons[0]?.directTokensPerStep).toBe(60);
    expect(comparisons[0]?.routerTokensPerStep).toBe(30);
    expect(comparisons[0]?.tokensPerStepDeltaPct).toBe(-50);
  });

  it('skips failed and unmeasured runs from the averages', () => {
    const comparisons = buildComparisons([
      summary('codex', 'direct', 500, 0.5, 10),
      summary('codex', 'direct', 700, 0.7, 10),
      summary('codex', 'router', 300, 0.3, 10),
      summary('codex', 'router', 0, 0, 0, { timedOut: true }),
      summary('codex', 'router', 0, 0, 0, { exitCode: 1 }),
      summary('codex', 'router', 0, 0, 0, {
        usage: { source: 'codex', available: false },
      }),
    ]);
    expect(comparisons[0]?.directTokens).toBe(600);
    expect(comparisons[0]?.routerTokens).toBe(300);
    expect(comparisons[0]?.routerSteps).toBe(10);
    expect(comparisons[0]?.tokenDeltaPct).toBe(-50);
    expect(comparisons[0]?.stepDeltaPct).toBe(0);
  });

  it('omits a comparison when a mode has only failed runs', () => {
    const comparisons = buildComparisons([
      summary('opencode', 'direct', 100, 1, 10),
      summary('opencode', 'router', 50, 0.5, 5, { timedOut: true }),
    ]);
    expect(comparisons).toEqual([]);
  });

  it('includes every supported agent, including Copilot', () => {
    const comparisons = buildComparisons([
      summary('copilot', 'direct', 800, 0.8, 10),
      summary('copilot', 'router', 400, 0.4, 10),
    ]);
    expect(comparisons.map((comparison) => comparison.agent)).toEqual(['copilot']);
  });

  it('keeps the no-tool-search Claude measurement separate', () => {
    const comparisons = buildComparisons([
      summary('claude', 'direct', 1_000, 1, 10),
      summary('claude', 'router', 900, 0.9, 10),
      summary('claude-no-tool-search', 'direct', 2_000, 2, 10),
      summary('claude-no-tool-search', 'router', 500, 0.5, 10),
    ]);
    expect(comparisons.map((comparison) => comparison.agent)).toEqual([
      'claude',
      'claude-no-tool-search',
    ]);
    expect(comparisons[0]?.tokenDeltaPct).toBe(-10);
    expect(comparisons[1]?.tokenDeltaPct).toBe(-75);
  });

  it('skips agents without both modes and handles a zero baseline', () => {
    expect(buildComparisons([summary('opencode', 'direct', 100, 1, 10)])).toEqual([]);
    const zero = buildComparisons([
      summary('opencode', 'direct', 0, 0, 0),
      summary('opencode', 'router', 100, 1, 10),
    ]);
    expect(zero[0]?.tokenDeltaPct).toBeNull();
    expect(zero[0]?.costDeltaPct).toBeNull();
    expect(zero[0]?.stepDeltaPct).toBeNull();
    expect(zero[0]?.tokensPerStepDeltaPct).toBeNull();
  });
});
