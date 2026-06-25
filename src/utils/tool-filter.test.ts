import { describe, it, expect } from 'vitest';
import { filterTools } from './tool-filter.js';
import type { ToolDescriptor } from './types.js';

function tool(name: string): ToolDescriptor {
  return { name, inputSchema: { type: 'object' } };
}

describe('filterTools', () => {
  it('is a function', () => {
    expect(typeof filterTools).toBe('function');
  });

  it('exposes all tools and marks them exposed when no filters are set', () => {
    const tools = [tool('a'), tool('b')];
    const result = filterTools(tools);
    expect(result.exposed.map((t) => t.name)).toEqual(['a', 'b']);
    expect(result.entries.map((e) => e.decision)).toEqual(['exposed', 'exposed']);
    expect(result.unmatchedPatterns).toEqual([]);
  });

  it('exposes only literal-matching tools when allowedTools is a list of literals', () => {
    const tools = [tool('list_issues'), tool('get_pull_request'), tool('delete_repo')];
    const result = filterTools(tools, ['list_issues', 'get_pull_request']);
    expect(result.exposed.map((t) => t.name)).toEqual(['list_issues', 'get_pull_request']);
    expect(result.entries.map((e) => [e.descriptor.name, e.decision])).toEqual([
      ['list_issues', 'exposed'],
      ['get_pull_request', 'exposed'],
      ['delete_repo', 'filtered'],
    ]);
  });

  it('matches glob patterns: file_* and *_read (User Story 2 scenario 4)', () => {
    const tools = [tool('file_read'), tool('file_write'), tool('db_read')];
    const result = filterTools(tools, ['file_*', '*_read']);
    expect(result.exposed.map((t) => t.name)).toEqual(['file_read', 'file_write', 'db_read']);
  });

  it('matches brace and character-class globs ({a,b} and [a-c])', () => {
    const tools = [tool('a'), tool('b'), tool('c'), tool('d')];
    const result = filterTools(tools, ['{a,b}', '[a-c]']);
    expect(result.exposed.map((t) => t.name)).toEqual(['a', 'b', 'c']);
    expect(result.entries.find((e) => e.descriptor.name === 'd')?.decision).toBe('filtered');
  });

  it('matches the ? single-char glob', () => {
    const tools = [tool('ab'), tool('abc'), tool('a')];
    const result = filterTools(tools, ['a?']);
    expect(result.exposed.map((t) => t.name)).toEqual(['ab']);
  });

  it('exposes zero tools when allowedTools is [] (User Story 2 scenario 3)', () => {
    const tools = [tool('a'), tool('b')];
    const result = filterTools(tools, []);
    expect(result.exposed).toEqual([]);
    expect(result.entries.map((e) => e.decision)).toEqual(['filtered', 'filtered']);
  });

  it('treats all tools as candidates when allowedTools is undefined (User Story 2 scenario 6)', () => {
    const tools = [tool('a'), tool('b'), tool('c')];
    const result = filterTools(tools, undefined);
    expect(result.exposed.map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('filters tools matching denylist globs and exposes the rest (User Story 3 scenario 2)', () => {
    const tools = [
      tool('file_delete'),
      tool('admin_purge'),
      tool('file_read'),
      tool('list_issues'),
    ];
    const result = filterTools(tools, undefined, ['*_delete', 'admin_*']);
    expect(result.exposed.map((t) => t.name)).toEqual(['file_read', 'list_issues']);
    expect(result.entries.find((e) => e.descriptor.name === 'file_delete')?.decision).toBe(
      'filtered',
    );
  });

  it('blocks a tool matching both lists — denylist wins (User Story 3 scenario 3)', () => {
    const tools = [tool('purge'), tool('list_issues')];
    const result = filterTools(tools, ['purge', 'list_issues'], ['purge']);
    expect(result.exposed.map((t) => t.name)).toEqual(['list_issues']);
    expect(result.entries.find((e) => e.descriptor.name === 'purge')?.decision).toBe('filtered');
  });

  it('treats denylist as absent when disabledTools is undefined (User Story 3 scenario 5)', () => {
    const tools = [tool('a'), tool('b')];
    const result = filterTools(tools, undefined, undefined);
    expect(result.exposed.map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('combines allowlist + denylist: allow narrows, deny further removes', () => {
    const tools = [tool('file_read'), tool('file_write'), tool('file_delete'), tool('db_read')];
    const result = filterTools(tools, ['file_*'], ['*_delete']);
    expect(result.exposed.map((t) => t.name)).toEqual(['file_read', 'file_write']);
  });

  it('reports unmatched allowlist literals and globs (User Story 2 scenario 5)', () => {
    const tools = [tool('file_read')];
    const result = filterTools(tools, ['file_read', 'nonexistent', 'no_*']);
    expect(result.exposed.map((t) => t.name)).toEqual(['file_read']);
    expect(result.unmatchedPatterns).toEqual(['nonexistent', 'no_*']);
  });

  it('reports unmatched denylist patterns (User Story 3 scenario 4)', () => {
    const tools = [tool('file_read')];
    const result = filterTools(tools, undefined, ['ghost_*', 'missing']);
    expect(result.unmatchedPatterns).toEqual(['ghost_*', 'missing']);
  });

  it('does not report a pattern as unmatched when at least one tool matches it', () => {
    const tools = [tool('file_read'), tool('file_write')];
    const result = filterTools(tools, ['file_*', 'lonely']);
    expect(result.unmatchedPatterns).toEqual(['lonely']);
  });

  it('lists unmatched allowlist patterns before unmatched denylist patterns', () => {
    const tools = [tool('keep')];
    const result = filterTools(tools, ['allow_ghost'], ['deny_ghost']);
    expect(result.unmatchedPatterns).toEqual(['allow_ghost', 'deny_ghost']);
  });

  it('returns no unmatched patterns when none are configured', () => {
    const tools = [tool('a')];
    const result = filterTools(tools);
    expect(result.unmatchedPatterns).toEqual([]);
  });

  it('does not throw on any input combination (patterns pre-validated upstream)', () => {
    const tools = [tool('a'), tool('b')];
    expect(() => filterTools(tools, [], [])).not.toThrow();
    expect(() => filterTools([], ['*'], ['*'])).not.toThrow();
    expect(() => filterTools([], undefined, undefined)).not.toThrow();
  });

  it('handles an empty tools array', () => {
    const result = filterTools([], ['*'], ['x']);
    expect(result.exposed).toEqual([]);
    expect(result.entries).toEqual([]);
    expect(result.unmatchedPatterns).toEqual(['*', 'x']);
  });
});
