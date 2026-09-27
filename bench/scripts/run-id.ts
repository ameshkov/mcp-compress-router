/**
 * Run identifier helpers for the benchmark.
 *
 * Run ids double as run directory names, so they are timestamped and
 * sortable, with a short random suffix to keep same-second runs apart.
 */
import { randomBytes } from 'node:crypto';
import type { BenchAgent, BenchMode } from './configs/types.js';

/**
 * Formats a run identifier from the agent, mode, and clock time.
 *
 * @param agent - The coding agent.
 * @param mode - The benchmark mode.
 * @param date - The timestamp to encode.
 * @returns A sortable run id, e.g. `claude-direct-20260922T143000-ab12`.
 */
export function formatRunId(agent: BenchAgent, mode: BenchMode, date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `${agent}-${mode}-${stamp}-${randomBytes(2).toString('hex')}`;
}
