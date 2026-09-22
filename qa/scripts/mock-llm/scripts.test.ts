import { describe, expect, it } from 'vitest';
import { LONG_DESCRIPTION_HEAD, LONG_DESCRIPTION_TAIL } from '../mock-long-description.js';
import { CLAUDE_TRUNCATION_MARKER, getScript, listScripts, scriptNames } from './scripts.js';

describe('built-in mock LLM scripts', () => {
  it('exposes every script through the lookup helpers', () => {
    const names = scriptNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(getScript(name)?.name).toBe(name);
    }
    expect(getScript('does-not-exist')).toBeUndefined();
  });

  it('lists a summary with step counts for every script', () => {
    const summaries = listScripts();
    expect(summaries.map((summary) => summary.name)).toEqual(scriptNames());
    for (const summary of summaries) {
      expect(summary.steps).toBeGreaterThan(0);
      expect(summary.description.length).toBeGreaterThan(0);
    }
  });

  it('serves each step as exactly one tool call or one text turn', () => {
    for (const name of scriptNames()) {
      for (const step of getScript(name)!.steps) {
        const isTool = 'tool' in step.respond;
        const isText = 'text' in step.respond;
        expect(isTool !== isText).toBe(true);
        if ('tool' in step.respond) {
          expect(step.respond.tool.name).toMatch(/^qa-router_/);
        }
      }
    }
  });

  it('covers the stdio, http, and oauth round trips', () => {
    expect(scriptNames()).toEqual(
      expect.arrayContaining([
        'stdio-catalog',
        'stdio-roundtrip',
        'tool-list',
        'http-catalog',
        'http-roundtrip',
        'oauth-catalog',
        'oauth-roundtrip',
        'retry',
        'fail',
        'stdio-descriptions',
        'long-description',
        'long-catalog-truncated',
        'dynamic-limit-degraded',
        'dynamic-limit-kept',
      ]),
    );
  });

  it('checks the degraded and kept catalogs in the dynamic-limit scripts', () => {
    const degraded = getScript('dynamic-limit-degraded');
    expect(degraded).toBeDefined();
    const first = degraded!.steps[0].expect;
    expect(first?.catalogIncludes).toContain('Provides 205 tools');
    expect(first?.catalogExcludes).toContain('bulk_tool_001');
    expect(degraded!.steps[1].expect?.messagesInclude).toContain('bulk_tool_001');

    const kept = getScript('dynamic-limit-kept');
    expect(kept).toBeDefined();
    expect(kept!.steps[0].expect?.catalogIncludes).toContain('bulk_tool_001');
    expect(kept!.steps[0].expect?.catalogExcludes).toContain('Provides 205 tools');
  });

  it('checks the list-mode signatures and hint in the tool-list script', () => {
    const script = getScript('tool-list');
    expect(script).toBeDefined();
    const expectations = script!.steps.flatMap((step) => step.expect?.messagesInclude ?? []);
    expect(expectations).toContain('echo(message)');
    expect(expectations).toContain('Call get_tool_schema with a tool name');
  });

  it('checks the catalog head and the full description in the result', () => {
    const script = getScript('long-description');
    expect(script).toBeDefined();
    const first = script!.steps[0].expect;
    expect(first?.catalogIncludes).toContain(LONG_DESCRIPTION_HEAD);
    expect(first?.catalogExcludes).toContain(LONG_DESCRIPTION_TAIL);
    expect(script!.steps[1].expect?.messagesInclude).toContain(LONG_DESCRIPTION_TAIL);
  });

  it('checks the head, the truncation marker, and the absent tail of the long catalog', () => {
    const script = getScript('long-catalog-truncated');
    expect(script).toBeDefined();
    const expect1 = script!.steps[0].expect;
    expect(expect1?.catalogIncludes).toContain('## stdio-mock-long');
    expect(expect1?.catalogIncludes).toContain(LONG_DESCRIPTION_HEAD);
    expect(expect1?.catalogIncludes).toContain(CLAUDE_TRUNCATION_MARKER);
    expect(expect1?.catalogExcludes).toContain(LONG_DESCRIPTION_TAIL);
  });
});
