/**
 * Report status labels for benchmark runs.
 */
import type { RunSummary } from './run-summary.js';

/**
 * Formats a run status for the report.
 *
 * @param summary - The run summary.
 * @returns A short status label.
 */
export function runStatus(summary: RunSummary): string {
  if (summary.timedOut) {
    return 'timeout';
  }
  if (summary.exitCode === null) {
    return 'killed';
  }
  if (summary.exitCode !== 0) {
    return `exit ${String(summary.exitCode)}`;
  }
  if (!summary.usage.available) {
    return 'no usage';
  }
  return 'ok';
}
