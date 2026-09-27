import { describe, expect, it } from 'vitest';
import { formatRunId } from './run-id.js';

describe('benchmark run ids', () => {
  it('encodes the agent, mode, and timestamp with a random suffix', () => {
    const runId = formatRunId('claude', 'direct', new Date('2026-09-22T14:30:00.000Z'));
    expect(runId).toMatch(/^claude-direct-20260922T143000-[0-9a-f]{4}$/);
  });

  it('generates unique ids for runs in the same second', () => {
    const date = new Date('2026-09-22T14:30:00.000Z');
    const ids = new Set(Array.from({ length: 20 }, () => formatRunId('opencode', 'router', date)));
    expect(ids.size).toBe(20);
  });
});
