/**
 * Router-vs-direct comparison logic for the benchmark report.
 *
 * Kept separate from the report entry point so it can be unit tested
 * without running the report itself.
 */
import { ALL_AGENTS, type BenchAgent } from './configs/types.js';
import type { RunSummary } from './run-summary.js';
import type { UsageTotals } from './usage.js';

/**
 * Router-vs-direct comparison for one agent.
 *
 * Every numeric field is a per-run average across the completed runs of
 * that mode, so repeated measurements smooth out the agent's run-to-run
 * variance instead of inflating the totals. Failed runs and runs without
 * usage totals are excluded.
 */
export interface ModeComparison {
  /** The coding agent. */
  agent: BenchAgent;
  /** LLM turns in direct mode. */
  directSteps: number;
  /** LLM turns in router mode. */
  routerSteps: number;
  /** Relative step change in percent, or null without a baseline. */
  stepDeltaPct: number | null;
  /** Total tokens in direct mode. */
  directTokens: number;
  /** Total tokens in router mode. */
  routerTokens: number;
  /** Relative token change in percent, or null without a baseline. */
  tokenDeltaPct: number | null;
  /** Average tokens per LLM turn in direct mode. */
  directTokensPerStep: number;
  /** Average tokens per LLM turn in router mode. */
  routerTokensPerStep: number;
  /** Relative tokens-per-step change in percent, or null without a baseline. */
  tokensPerStepDeltaPct: number | null;
  /** Non-cached input tokens in direct mode. */
  directInputTokens: number;
  /** Non-cached input tokens in router mode. */
  routerInputTokens: number;
  /** Cache-read input tokens in direct mode. */
  directCacheReadTokens: number;
  /** Cache-read input tokens in router mode. */
  routerCacheReadTokens: number;
  /** Cache-creation input tokens in direct mode. */
  directCacheCreationTokens: number;
  /** Cache-creation input tokens in router mode. */
  routerCacheCreationTokens: number;
  /** Output tokens in direct mode. */
  directOutputTokens: number;
  /** Output tokens in router mode. */
  routerOutputTokens: number;
  /** Cost in direct mode. */
  directCost: number;
  /** Cost in router mode. */
  routerCost: number;
  /** Relative cost change in percent, or null without a baseline. */
  costDeltaPct: number | null;
}

/**
 * Computes the relative change between two values.
 *
 * @param from - The baseline value.
 * @param to - The new value.
 * @returns The change in percent, or null when the baseline is zero.
 */
function percentDelta(from: number, to: number): number | null {
  return from <= 0 ? null : ((to - from) / from) * 100;
}

/**
 * Averages one usage field over a list of run summaries.
 *
 * @param summaries - The runs to average.
 * @param field - The usage totals field to average.
 * @returns The per-run average, treating missing totals as zero.
 */
function averageUsage(summaries: RunSummary[], field: keyof UsageTotals): number {
  if (summaries.length === 0) {
    return 0;
  }
  const total = summaries.reduce((sum, summary) => sum + (summary.usage.totals?.[field] ?? 0), 0);
  return total / summaries.length;
}

/**
 * Averages the step counts of a list of run summaries.
 *
 * @param summaries - The runs to average.
 * @returns The average number of LLM turns per run.
 */
function averageSteps(summaries: RunSummary[]): number {
  if (summaries.length === 0) {
    return 0;
  }
  return summaries.reduce((sum, summary) => sum + summary.steps, 0) / summaries.length;
}

/**
 * Checks whether a run can contribute to the comparison averages.
 *
 * A failed run (timeout or non-zero exit) or a run whose usage lookup
 * failed would contribute zero tokens and steps, skewing the
 * direct-vs-router deltas toward whichever mode failed more.
 *
 * @param summary - The run summary to inspect.
 * @returns True when the run finished cleanly and usage was extracted.
 */
function isComparable(summary: RunSummary): boolean {
  return !summary.timedOut && summary.exitCode === 0 && summary.usage.available;
}

/**
 * Pairs direct and router runs per agent and computes the deltas.
 *
 * Multiple completed runs per mode are averaged, so repeated
 * measurements smooth out the run-to-run variance of the agent instead
 * of inflating the totals. Failed runs and runs without usage totals are
 * skipped, so one bad run cannot skew the deltas toward the mode that
 * failed more often.
 *
 * @param summaries - All run summaries.
 * @returns One comparison per agent that has both modes.
 */
export function buildComparisons(summaries: RunSummary[]): ModeComparison[] {
  const usable = summaries.filter(isComparable);
  const comparisons: ModeComparison[] = [];
  for (const agent of ALL_AGENTS) {
    const direct = usable.filter((summary) => summary.agent === agent && summary.mode === 'direct');
    const router = usable.filter((summary) => summary.agent === agent && summary.mode === 'router');
    if (direct.length === 0 || router.length === 0) {
      continue;
    }
    const directSteps = averageSteps(direct);
    const routerSteps = averageSteps(router);
    const directTokens = averageUsage(direct, 'totalTokens');
    const routerTokens = averageUsage(router, 'totalTokens');
    const directCost = averageUsage(direct, 'totalCost');
    const routerCost = averageUsage(router, 'totalCost');
    const directTokensPerStep = directSteps === 0 ? 0 : directTokens / directSteps;
    const routerTokensPerStep = routerSteps === 0 ? 0 : routerTokens / routerSteps;
    comparisons.push({
      agent,
      directSteps,
      routerSteps,
      stepDeltaPct: percentDelta(directSteps, routerSteps),
      directTokens,
      routerTokens,
      tokenDeltaPct: percentDelta(directTokens, routerTokens),
      directTokensPerStep,
      routerTokensPerStep,
      tokensPerStepDeltaPct: percentDelta(directTokensPerStep, routerTokensPerStep),
      directInputTokens: averageUsage(direct, 'inputTokens'),
      routerInputTokens: averageUsage(router, 'inputTokens'),
      directCacheReadTokens: averageUsage(direct, 'cacheReadTokens'),
      routerCacheReadTokens: averageUsage(router, 'cacheReadTokens'),
      directCacheCreationTokens: averageUsage(direct, 'cacheCreationTokens'),
      routerCacheCreationTokens: averageUsage(router, 'cacheCreationTokens'),
      directOutputTokens: averageUsage(direct, 'outputTokens'),
      routerOutputTokens: averageUsage(router, 'outputTokens'),
      directCost,
      routerCost,
      costDeltaPct: percentDelta(directCost, routerCost),
    });
  }
  return comparisons;
}
