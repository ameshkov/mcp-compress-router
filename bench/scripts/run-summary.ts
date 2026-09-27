/**
 * Run-summary records shared by the benchmark runner and reporter.
 *
 * Every run writes `summary.json` into its run directory; the reporter
 * reads them back to build the direct-vs-router comparison.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BenchAgent, BenchMode } from './configs/types.js';
import type { UsageReport, UsageTotals } from './usage.js';

/** One completed benchmark run. */
export interface RunSummary {
  /** Unique run identifier (also the run directory name). */
  runId: string;
  /** The coding agent that was driven. */
  agent: BenchAgent;
  /** Direct MCP servers or via the router. */
  mode: BenchMode;
  /** Model id used for the run. */
  model: string;
  /** ISO timestamp when the agent was started. */
  startedAt: string;
  /** ISO timestamp when the agent finished. */
  finishedAt: string;
  /** Agent exit code, or null when killed or not started. */
  exitCode: number | null;
  /** True when the run hit the timeout. */
  timedOut: boolean;
  /** Agent wall-clock duration in milliseconds. */
  durationMs: number;
  /** LLM turns observed in the agent event stream. */
  steps: number;
  /** Agent session id, when reported. */
  sessionID: string;
  /** Number of calls the agent made to the mock MCP stubs. */
  mcpInvocations: number;
  /** ccusage result for this run. */
  usage: UsageReport;
}

/** Numeric fields of a usage totals record. */
const USAGE_TOTAL_FIELDS: Array<keyof UsageTotals> = [
  'inputTokens',
  'outputTokens',
  'cacheCreationTokens',
  'cacheReadTokens',
  'totalTokens',
  'totalCost',
];

/**
 * Checks whether a parsed value is a usage totals record.
 *
 * @param value - The parsed JSON value.
 * @returns True when every totals field is a number.
 */
function isUsageTotals(value: unknown): value is UsageTotals {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return USAGE_TOTAL_FIELDS.every((field) => typeof record[field] === 'number');
}

/**
 * Checks whether a parsed value is a usage report.
 *
 * The report reads `usage.available` and `usage.totals` directly, so a
 * summary without a usage report would crash it instead of being
 * skipped.
 *
 * @param value - The parsed JSON value.
 * @returns True when the usage report has the shape the report reads.
 */
function isUsageReport(value: unknown): value is UsageReport {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.available !== 'boolean' || typeof record.source !== 'string') {
    return false;
  }
  return !record.available || isUsageTotals(record.totals);
}

/**
 * Checks whether a parsed value looks like a run summary.
 *
 * The report reads `model`, `durationMs`, and `mcpInvocations` directly,
 * so a summary missing them would crash the table renderer instead of
 * being skipped.
 *
 * @param value - The parsed JSON value.
 * @returns True when the fields the report reads are present.
 */
function isRunSummary(value: unknown): value is RunSummary {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.runId === 'string' &&
    typeof record.agent === 'string' &&
    (record.mode === 'direct' || record.mode === 'router') &&
    typeof record.model === 'string' &&
    (record.exitCode === null || typeof record.exitCode === 'number') &&
    typeof record.timedOut === 'boolean' &&
    typeof record.durationMs === 'number' &&
    typeof record.steps === 'number' &&
    typeof record.mcpInvocations === 'number' &&
    isUsageReport(record.usage)
  );
}

/**
 * Reads every run summary under a runs directory.
 *
 * Unreadable or malformed summaries are skipped so one bad run cannot
 * break the report.
 *
 * @param runsDir - The directory holding the run directories.
 * @returns The summaries, sorted by agent then mode.
 */
export async function readRunSummaries(runsDir: string): Promise<RunSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return [];
  }
  const summaries: RunSummary[] = [];
  for (const entry of entries) {
    try {
      const text = await readFile(join(runsDir, entry, 'summary.json'), 'utf8');
      const parsed: unknown = JSON.parse(text);
      if (isRunSummary(parsed)) {
        summaries.push(parsed);
      }
    } catch {
      continue;
    }
  }
  const modeOrder: Record<BenchMode, number> = { direct: 0, router: 1 };
  return summaries.sort(
    (left, right) =>
      left.agent.localeCompare(right.agent) ||
      modeOrder[left.mode] - modeOrder[right.mode] ||
      left.runId.localeCompare(right.runId),
  );
}
