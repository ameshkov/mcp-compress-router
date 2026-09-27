/**
 * ccusage integration for the benchmark.
 *
 * Each run keeps its agent data in a hermetic home, so pointing ccusage
 * at that home yields the usage of exactly one run. The parser accepts
 * both the current focused report shape (`{ sessions: [...], totals }`)
 * and the legacy shape (`{ data: [...], summary }`) so the harness
 * survives ccusage upgrades.
 */
import { spawnAgent, waitForExit } from './agent/process.js';
import type { BenchAgent } from './configs/types.js';

/** Default timeout for one ccusage invocation. */
const USAGE_TIMEOUT_MS = 120_000;

/** Token and cost totals of one run. */
export interface UsageTotals {
  /** Non-cached input tokens. */
  inputTokens: number;
  /** Output tokens. */
  outputTokens: number;
  /** Cache-creation input tokens. */
  cacheCreationTokens: number;
  /** Cache-read input tokens. */
  cacheReadTokens: number;
  /** Sum of all token types. */
  totalTokens: number;
  /** Estimated cost in USD. */
  totalCost: number;
}

/** Result of one ccusage lookup. */
export interface UsageReport {
  /** The agent whose data was read. */
  source: BenchAgent;
  /** True when totals were extracted. */
  available: boolean;
  /** The extracted totals, when available. */
  totals?: UsageTotals;
  /** Why the lookup failed, when it did. */
  error?: string;
}

/**
 * Checks whether a value is a plain record.
 *
 * @param value - The value to inspect.
 * @returns True for non-null objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads the first numeric property among the given names.
 *
 * @param record - The source record.
 * @param keys - Candidate property names.
 * @returns The first finite number found, or 0.
 */
function numberAt(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

/**
 * Maps a current-shape row (camelCase keys) to totals.
 *
 * @param record - The source record.
 * @returns The mapped totals.
 */
function fromCurrentShape(record: Record<string, unknown>): UsageTotals {
  return {
    inputTokens: numberAt(record, ['inputTokens']),
    outputTokens: numberAt(record, ['outputTokens']),
    cacheCreationTokens: numberAt(record, ['cacheCreationTokens']),
    cacheReadTokens: numberAt(record, ['cacheReadTokens']),
    totalTokens: numberAt(record, ['totalTokens']),
    totalCost: numberAt(record, ['totalCost', 'costUSD']),
  };
}

/**
 * Maps a legacy summary row (`total*` keys) to totals.
 *
 * @param record - The source record.
 * @returns The mapped totals.
 */
function fromLegacySummary(record: Record<string, unknown>): UsageTotals {
  return {
    inputTokens: numberAt(record, ['totalInputTokens', 'inputTokens']),
    outputTokens: numberAt(record, ['totalOutputTokens', 'outputTokens']),
    cacheCreationTokens: numberAt(record, ['totalCacheCreationTokens', 'cacheCreationTokens']),
    cacheReadTokens: numberAt(record, ['totalCacheReadTokens', 'cacheReadTokens']),
    totalTokens: numberAt(record, ['totalTokens']),
    totalCost: numberAt(record, ['totalCostUSD', 'totalCost']),
  };
}

/**
 * Sums a list of totals.
 *
 * @param rows - The totals to sum.
 * @returns The summed totals.
 */
function sumTotals(rows: UsageTotals[]): UsageTotals {
  return rows.reduce(
    (sum, row) => ({
      inputTokens: sum.inputTokens + row.inputTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
      cacheCreationTokens: sum.cacheCreationTokens + row.cacheCreationTokens,
      cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
      totalTokens: sum.totalTokens + row.totalTokens,
      totalCost: sum.totalCost + row.totalCost,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      totalCost: 0,
    },
  );
}

/**
 * Picks the row array from a ccusage document.
 *
 * Current reports use `sessions`; older focused reports used `session`,
 * and the legacy report shape used `data`.
 *
 * @param raw - The parsed JSON document.
 * @returns The first row array found, or an empty array.
 */
function rowArray(raw: Record<string, unknown>): unknown[] {
  for (const key of ['sessions', 'session', 'data']) {
    const value = raw[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

/**
 * Extracts usage totals from a parsed ccusage report.
 *
 * @param raw - The parsed JSON document.
 * @returns The totals, or undefined when the document has none.
 */
export function parseUsageJson(raw: unknown): UsageTotals | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const totals = isRecord(raw.totals) ? raw.totals : undefined;
  if (totals !== undefined && typeof totals.totalTokens === 'number') {
    return fromCurrentShape(totals);
  }
  const summary = isRecord(raw.summary) ? raw.summary : undefined;
  if (summary !== undefined && typeof summary.totalTokens === 'number') {
    return fromLegacySummary(summary);
  }
  const entries = rowArray(raw).filter(isRecord).map(fromCurrentShape);
  return entries.length === 0 ? undefined : sumTotals(entries);
}

/**
 * Extracts the JSON document from ccusage stdout.
 *
 * @param stdout - The raw stdout text.
 * @returns The parsed document, or undefined.
 */
function extractJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start === -1 || end <= start) {
      return undefined;
    }
    try {
      return JSON.parse(stdout.slice(start, end + 1)) as unknown;
    } catch {
      return undefined;
    }
  }
}

/**
 * Runs ccusage for one run's hermetic agent home.
 *
 * @param source - The ccusage data source.
 * @param usageEnv - Environment overrides pointing at the run's data.
 * @param offline - Whether to pass `--offline` (cached pricing only).
 * @returns The usage report.
 */
export async function collectUsage(
  source: BenchAgent,
  usageEnv: NodeJS.ProcessEnv,
  offline: boolean,
): Promise<UsageReport> {
  const args = [source, 'session', '--json'];
  if (offline) {
    args.push('--offline');
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ...usageEnv, LOG_LEVEL: '0', NO_COLOR: '1' };
  const child = spawnAgent('ccusage', args, env, process.cwd());
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exit = await waitForExit(child, USAGE_TIMEOUT_MS);
  if (exit.spawnError !== null) {
    return {
      source,
      available: false,
      error: `ccusage failed to start: ${exit.spawnError.message}`,
    };
  }
  if (exit.timedOut) {
    return { source, available: false, error: 'ccusage timed out.' };
  }
  const document = extractJson(stdout);
  if (document === undefined) {
    const detail = stderr.trim() === '' ? `exit code ${String(exit.code)}` : stderr.trim();
    return { source, available: false, error: `ccusage produced no JSON output (${detail}).` };
  }
  const totals = parseUsageJson(document);
  if (totals === undefined) {
    return { source, available: false, error: 'ccusage JSON contained no token totals.' };
  }
  return { source, available: true, totals };
}
