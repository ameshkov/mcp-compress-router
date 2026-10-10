import { describe, expect, it } from 'vitest';
import { LONG_DESCRIPTION_HEAD, LONG_DESCRIPTION_TAIL } from '../mock-long-description.js';
import { DOWNSTREAM_TOOLS, HTTP_DOWNSTREAM_TOOLS } from './script-constants.js';
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
      ]),
    );
  });

  it('checks the compact catalog and the list-mode signatures in the catalog script', () => {
    const script = getScript('stdio-catalog');
    expect(script).toBeDefined();
    const first = script!.steps[0].expect;
    expect(first?.catalogIncludes).toContain('- stdio-mock (6 tools)');
    expect(first?.catalogExcludes).toEqual(
      expect.arrayContaining([
        'echo',
        'add',
        'multi_block',
        'failing_tool',
        'documented_tool',
        'slow_tool',
      ]),
    );
    expect(script!.steps[1].expect?.messagesInclude).toContain('echo(message)');
    expect(script!.steps[1].expect?.messagesInclude).toContain('documented_tool(input)');
    expect(script!.steps[1].expect?.messagesInclude).toContain('slow_tool(delay_ms)');
  });

  it('derives the HTTP downstream tool names from the signatures', () => {
    expect(DOWNSTREAM_TOOLS).not.toContain('whoami');
    expect(HTTP_DOWNSTREAM_TOOLS).toEqual([...DOWNSTREAM_TOOLS, 'whoami']);
  });

  it('checks the http catalog excludes every HTTP tool, including whoami', () => {
    const script = getScript('http-catalog');
    expect(script).toBeDefined();
    const first = script!.steps[0].expect;
    expect(first?.catalogIncludes).toContain('- http-mock (7 tools)');
    expect(first?.catalogExcludes).toContain('whoami');
    expect(first?.toolsAbsent).toContain('whoami');
    expect(script!.steps[1].expect?.messagesInclude).toContain('whoami()');
  });

  it('checks the oauth catalog and the HTTP round trips exclude whoami too', () => {
    const oauthCatalog = getScript('oauth-catalog')!.steps[0].expect;
    expect(oauthCatalog?.catalogExcludes).toContain('whoami');
    for (const name of ['oauth-catalog', 'http-roundtrip', 'oauth-roundtrip']) {
      expect(getScript(name)!.steps[0].expect?.toolsAbsent).toContain('whoami');
    }
  });

  it('checks the list-mode signatures and hint in the tool-list script', () => {
    const script = getScript('tool-list');
    expect(script).toBeDefined();
    const expectations = script!.steps.flatMap((step) => step.expect?.messagesInclude ?? []);
    expect(expectations).toContain('echo(message)');
    expect(expectations).toContain('Call get_tool_schema with a tool name');
  });

  it('checks that the long description arrives through the result, not the catalog', () => {
    const script = getScript('long-description');
    expect(script).toBeDefined();
    const first = script!.steps[0].expect;
    expect(first?.catalogExcludes).toContain(LONG_DESCRIPTION_HEAD);
    expect(first?.catalogExcludes).toContain(LONG_DESCRIPTION_TAIL);
    expect(script!.steps[1].expect?.messagesInclude).toContain(LONG_DESCRIPTION_TAIL);
  });

  it('checks the head, the truncation marker, and the absent tail of the long catalog', () => {
    const script = getScript('long-catalog-truncated');
    expect(script).toBeDefined();
    const expect1 = script!.steps[0].expect;
    expect(expect1?.catalogIncludes).toContain('- stdio-mock-long (');
    expect(expect1?.catalogIncludes).toContain(LONG_DESCRIPTION_HEAD);
    expect(expect1?.catalogIncludes).toContain(CLAUDE_TRUNCATION_MARKER);
    expect(expect1?.catalogExcludes).toContain(LONG_DESCRIPTION_TAIL);
  });
});
