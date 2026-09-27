import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BenchAgent, BenchMode } from './configs/types.js';
import { readRunSummaries, type RunSummary } from './run-summary.js';

/**
 * Builds a minimal valid run summary.
 *
 * @param runId - The run identifier.
 * @param agent - The coding agent.
 * @param mode - The benchmark mode.
 * @returns A complete run summary.
 */
function summary(runId: string, agent: BenchAgent, mode: BenchMode): RunSummary {
  return {
    runId,
    agent,
    mode,
    model: 'test-model',
    startedAt: '2026-09-22T10:00:00.000Z',
    finishedAt: '2026-09-22T10:10:00.000Z',
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    steps: 0,
    sessionID: '',
    mcpInvocations: 0,
    usage: { source: agent, available: false, error: 'not measured' },
  };
}

describe('run summary reading', () => {
  it('reads and sorts valid summaries and skips malformed entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-run-summary-test-'));
    try {
      const entries: Array<[string, RunSummary | Record<string, unknown> | string]> = [
        ['claude-router', summary('claude-router', 'claude', 'router')],
        ['claude-direct', summary('claude-direct', 'claude', 'direct')],
        ['codex-direct', summary('codex-direct', 'codex', 'direct')],
        ['broken', '{ not json'],
      ];
      const legacy = summary('legacy-direct', 'claude', 'direct') as unknown as Record<
        string,
        unknown
      >;
      delete legacy.steps;
      entries.push(['legacy-direct', legacy]);
      for (const [name, content] of entries) {
        await mkdir(join(root, name), { recursive: true });
        await writeFile(
          join(root, name, 'summary.json'),
          typeof content === 'string' ? content : JSON.stringify(content),
          'utf8',
        );
      }
      await mkdir(join(root, 'no-summary'), { recursive: true });
      const summaries = await readRunSummaries(root);
      expect(summaries.map((entry) => entry.runId)).toEqual([
        'claude-direct',
        'claude-router',
        'codex-direct',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips summaries whose required fields are malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-run-summary-test-'));
    try {
      const noUsage = summary('no-usage', 'claude', 'direct') as unknown as Record<string, unknown>;
      delete noUsage.usage;
      const nullUsage = summary('null-usage', 'claude', 'direct') as unknown as Record<
        string,
        unknown
      >;
      nullUsage.usage = null;
      const missingTotals = summary('missing-totals', 'claude', 'direct') as unknown as Record<
        string,
        unknown
      >;
      const usage = missingTotals.usage as Record<string, unknown>;
      usage.available = true;
      delete usage.totals;
      const badMode = summary('bad-mode', 'claude', 'direct') as unknown as Record<string, unknown>;
      badMode.mode = 'sideways';
      const noModel = summary('no-model', 'claude', 'direct') as unknown as Record<string, unknown>;
      delete noModel.model;
      const noDuration = summary('no-duration', 'claude', 'direct') as unknown as Record<
        string,
        unknown
      >;
      delete noDuration.durationMs;
      const noInvocations = summary('no-invocations', 'claude', 'direct') as unknown as Record<
        string,
        unknown
      >;
      delete noInvocations.mcpInvocations;
      const entries: Array<[string, Record<string, unknown>]> = [
        ['no-usage', noUsage],
        ['null-usage', nullUsage],
        ['missing-totals', missingTotals],
        ['bad-mode', badMode],
        ['no-model', noModel],
        ['no-duration', noDuration],
        ['no-invocations', noInvocations],
      ];
      for (const [name, content] of entries) {
        await mkdir(join(root, name), { recursive: true });
        await writeFile(join(root, name, 'summary.json'), JSON.stringify(content), 'utf8');
      }
      await mkdir(join(root, 'valid'), { recursive: true });
      await writeFile(
        join(root, 'valid', 'summary.json'),
        JSON.stringify(summary('valid', 'claude', 'direct')),
        'utf8',
      );

      const summaries = await readRunSummaries(root);

      expect(summaries.map((entry) => entry.runId)).toEqual(['valid']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns an empty list for a missing runs directory', async () => {
    expect(await readRunSummaries(join(tmpdir(), 'bench-does-not-exist'))).toEqual([]);
  });
});
