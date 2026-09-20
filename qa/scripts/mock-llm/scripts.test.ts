import { describe, expect, it } from 'vitest';
import { LONG_DESCRIPTION_HEAD, LONG_DESCRIPTION_TAIL } from '../mock-long-description.js';
import { getScript, listScripts, scriptNames } from './scripts.js';

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
        'http-catalog',
        'http-roundtrip',
        'oauth-catalog',
        'oauth-roundtrip',
        'retry',
        'fail',
        'stdio-descriptions',
        'long-description',
      ]),
    );
  });

  it('checks both markers of the long description', () => {
    const script = getScript('long-description');
    expect(script).toBeDefined();
    const expectations = script!.steps.flatMap((step) => [
      ...(step.expect?.catalogIncludes ?? []),
      ...(step.expect?.messagesInclude ?? []),
    ]);
    expect(expectations).toContain(LONG_DESCRIPTION_HEAD);
    expect(expectations).toContain(LONG_DESCRIPTION_TAIL);
  });

  it('checks the truncation boundary of the truncated long description', () => {
    const script = getScript('long-description-truncated');
    expect(script).toBeDefined();
    const first = script!.steps[0].expect;
    expect(first?.catalogIncludes).toContain(LONG_DESCRIPTION_HEAD);
    expect(first?.catalogExcludes).toContain(LONG_DESCRIPTION_TAIL);
    expect(script!.steps[1].expect?.messagesInclude).toContain(LONG_DESCRIPTION_TAIL);
  });
});
