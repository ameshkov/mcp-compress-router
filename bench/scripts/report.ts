#!/usr/bin/env tsx
/**
 * Builds the benchmark comparison report.
 *
 * Reads every `summary.json` under the runs directory and prints a
 * table plus the router-vs-direct delta per agent, then writes
 * `report.md` and `report.json` next to the runs.
 *
 * Usage:
 *   tsx bench/scripts/report.ts
 *   tsx bench/scripts/report.ts --runs-dir /bench/runs
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { scriptArgs } from './args.js';
import { buildComparisons, type ModeComparison } from './comparison.js';
import { runStatus } from './run-status.js';
import { readRunSummaries, type RunSummary } from './run-summary.js';

/** Default runs directory inside the benchmark image. */
const DEFAULT_RUNS_DIR = '/bench/runs';

/**
 * Renders a left-aligned text table.
 *
 * @param headers - The column headers.
 * @param rows - The body rows.
 * @returns The rendered table.
 */
function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const render = (cells: string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    render(headers),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...rows.map(render),
  ].join('\n');
}

/**
 * Formats a percentage delta for the report.
 *
 * @param value - The delta in percent, or null without a baseline.
 * @returns The signed percentage, or '-' without a baseline.
 */
function formatPercent(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(1)}%`;
}

/**
 * Formats a direct-to-router pair with its relative delta.
 *
 * @param from - The direct-mode value.
 * @param to - The router-mode value.
 * @returns A compact `from -> to (delta)` cell.
 */
function formatPair(from: number, to: number): string {
  const delta = from <= 0 ? null : ((to - from) / from) * 100;
  return (
    `${from.toLocaleString('en-US')} -> ${to.toLocaleString('en-US')} ` +
    `(${formatPercent(delta)})`
  );
}

/**
 * Formats one run as a report row.
 *
 * @param summary - The run summary.
 * @returns The table row cells.
 */
function runRow(summary: RunSummary): string[] {
  const totals = summary.usage.totals;
  return [
    summary.agent,
    summary.mode,
    summary.model,
    totals === undefined ? '-' : totals.totalTokens.toLocaleString('en-US'),
    totals === undefined ? '-' : totals.inputTokens.toLocaleString('en-US'),
    totals === undefined ? '-' : totals.cacheReadTokens.toLocaleString('en-US'),
    totals === undefined ? '-' : totals.cacheCreationTokens.toLocaleString('en-US'),
    totals === undefined ? '-' : totals.outputTokens.toLocaleString('en-US'),
    totals === undefined ? '-' : `$${totals.totalCost.toFixed(4)}`,
    `${Math.round(summary.durationMs / 1000)}s`,
    String(summary.steps),
    String(summary.mcpInvocations),
    runStatus(summary),
  ];
}

/**
 * Renders the per-run markdown table.
 *
 * @param summaries - All run summaries.
 * @returns The section lines.
 */
function runsSection(summaries: RunSummary[]): string[] {
  return [
    '## Runs',
    '',
    '| agent | mode | model | total tokens | input | cache read | cache create | output | cost | duration | steps | MCP calls | status |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...summaries.map((summary) => `| ${runRow(summary).join(' | ')} |`),
  ];
}

/**
 * Renders the router-vs-direct markdown table.
 *
 * @param comparisons - The router-vs-direct comparisons.
 * @returns The section lines.
 */
function routerEffectSection(comparisons: ModeComparison[]): string[] {
  if (comparisons.length === 0) {
    return [
      '## Router effect (router vs direct)',
      '',
      'No agent has both a direct and a router run yet.',
    ];
  }
  const lines = [
    '## Router effect (router vs direct)',
    '',
    '| agent | direct avg steps | router avg steps | step delta | direct avg tokens | router avg tokens | token delta | direct avg cost | router avg cost | cost delta |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const comparison of comparisons) {
    lines.push(
      `| ${comparison.agent} | ${comparison.directSteps} | ${comparison.routerSteps} | ` +
        `${formatPercent(comparison.stepDeltaPct)} | ` +
        `${comparison.directTokens.toLocaleString('en-US')} | ` +
        `${comparison.routerTokens.toLocaleString('en-US')} | ` +
        `${formatPercent(comparison.tokenDeltaPct)} | ` +
        `$${comparison.directCost.toFixed(4)} | $${comparison.routerCost.toFixed(4)} | ` +
        `${formatPercent(comparison.costDeltaPct)} |`,
    );
  }
  return lines;
}

/**
 * Renders the tokens-per-turn markdown table.
 *
 * @param comparisons - The router-vs-direct comparisons.
 * @returns The section lines.
 */
function contextPerStepSection(comparisons: ModeComparison[]): string[] {
  const lines = [
    '## Context per step (avg direct -> router)',
    '',
    '| agent | direct tokens/step | router tokens/step | delta |',
    '| --- | ---: | ---: | ---: |',
  ];
  for (const comparison of comparisons) {
    lines.push(
      `| ${comparison.agent} | ` +
        `${Math.round(comparison.directTokensPerStep).toLocaleString('en-US')} | ` +
        `${Math.round(comparison.routerTokensPerStep).toLocaleString('en-US')} | ` +
        `${formatPercent(comparison.tokensPerStepDeltaPct)} |`,
    );
  }
  return lines;
}

/**
 * Renders the per-component token distribution markdown table.
 *
 * @param comparisons - The router-vs-direct comparisons.
 * @returns The section lines.
 */
function distributionSection(comparisons: ModeComparison[]): string[] {
  const lines = [
    '## Token distribution (avg direct -> router)',
    '',
    '| agent | input | cache read | cache create | output |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const comparison of comparisons) {
    lines.push(
      `| ${comparison.agent} | ` +
        `${formatPair(comparison.directInputTokens, comparison.routerInputTokens)} | ` +
        `${formatPair(comparison.directCacheReadTokens, comparison.routerCacheReadTokens)} | ` +
        `${formatPair(comparison.directCacheCreationTokens, comparison.routerCacheCreationTokens)} | ` +
        `${formatPair(comparison.directOutputTokens, comparison.routerOutputTokens)} |`,
    );
  }
  return lines;
}

/**
 * Renders the markdown report.
 *
 * @param summaries - All run summaries.
 * @param comparisons - The router-vs-direct comparisons.
 * @param generatedAt - ISO timestamp of the report.
 * @returns The markdown document.
 */
function markdownReport(
  summaries: RunSummary[],
  comparisons: ModeComparison[],
  generatedAt: string,
): string {
  const lines = [
    '# Benchmark report',
    '',
    `Generated: ${generatedAt}`,
    '',
    ...runsSection(summaries),
    '',
    ...routerEffectSection(comparisons),
  ];
  if (comparisons.length > 0) {
    lines.push('', ...contextPerStepSection(comparisons), '', ...distributionSection(comparisons));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Prints the router-vs-direct comparison lines.
 *
 * @param comparisons - The router-vs-direct comparisons.
 */
function printComparisons(comparisons: ModeComparison[]): void {
  if (comparisons.length === 0) {
    return;
  }
  console.log('\nRouter effect (router vs direct):');
  for (const comparison of comparisons) {
    console.log(
      `  ${comparison.agent}: ${Math.round(comparison.directTokens).toLocaleString('en-US')} -> ` +
        `${Math.round(comparison.routerTokens).toLocaleString('en-US')} avg tokens ` +
        `(${formatPercent(comparison.tokenDeltaPct)}), ` +
        `${comparison.directSteps} -> ${comparison.routerSteps} avg steps ` +
        `(${formatPercent(comparison.stepDeltaPct)}), ` +
        `$${comparison.directCost.toFixed(4)} -> $${comparison.routerCost.toFixed(4)} avg cost ` +
        `(${formatPercent(comparison.costDeltaPct)})`,
    );
    console.log(
      `    tokens/step ${Math.round(comparison.directTokensPerStep).toLocaleString('en-US')} -> ` +
        `${Math.round(comparison.routerTokensPerStep).toLocaleString('en-US')} ` +
        `(${formatPercent(comparison.tokensPerStepDeltaPct)})`,
    );
    console.log(
      `    input ${formatPair(comparison.directInputTokens, comparison.routerInputTokens)} | ` +
        `cache read ${formatPair(comparison.directCacheReadTokens, comparison.routerCacheReadTokens)} | ` +
        `cache create ${formatPair(comparison.directCacheCreationTokens, comparison.routerCacheCreationTokens)} | ` +
        `output ${formatPair(comparison.directOutputTokens, comparison.routerOutputTokens)}`,
    );
  }
}

/**
 * Prints the console report.
 *
 * @param summaries - All run summaries.
 * @param comparisons - The router-vs-direct comparisons.
 * @param runsRoot - The runs directory.
 */
function printConsoleReport(
  summaries: RunSummary[],
  comparisons: ModeComparison[],
  runsRoot: string,
): void {
  console.log(`\nBenchmark results (${runsRoot})\n`);
  console.log(
    formatTable(
      [
        'agent',
        'mode',
        'model',
        'total tokens',
        'input',
        'cache read',
        'cache create',
        'output',
        'cost',
        'duration',
        'steps',
        'MCP calls',
        'status',
      ],
      summaries.map(runRow),
    ),
  );
  printComparisons(comparisons);
}

/**
 * Builds and writes the benchmark report.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    args: scriptArgs(process.argv.slice(2)),
    options: { 'runs-dir': { type: 'string' } },
  });
  const runsRoot = values['runs-dir'] ?? process.env.BENCH_RUNS_DIR ?? DEFAULT_RUNS_DIR;
  const summaries = await readRunSummaries(runsRoot);
  if (summaries.length === 0) {
    console.error(`No run summaries found under ${runsRoot}.`);
    process.exitCode = 1;
    return;
  }
  const generatedAt = new Date().toISOString();
  const comparisons = buildComparisons(summaries);
  printConsoleReport(summaries, comparisons, runsRoot);
  await writeFile(
    join(runsRoot, 'report.json'),
    `${JSON.stringify({ generatedAt, runsRoot, runs: summaries, comparisons }, null, 2)}\n`,
  );
  await writeFile(join(runsRoot, 'report.md'), markdownReport(summaries, comparisons, generatedAt));
  console.log(`\nWrote ${join(runsRoot, 'report.md')} and ${join(runsRoot, 'report.json')}`);
}

try {
  await main();
} catch (error) {
  console.error(`bench report failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
