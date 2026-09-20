import { describe, expect, it } from 'vitest';
import { formatCheckFailures, runChecks } from './checks.js';
import { resolveScriptedToolName, type WireChatRequest } from './tool-names.js';

/**
 * Builds a model request shaped like the one opencode sends.
 *
 * @param overrides - Fields to replace on the default request.
 * @returns The request.
 */
function makeRequest(overrides: Partial<WireChatRequest> = {}): WireChatRequest {
  return {
    tools: [
      {
        function: {
          name: 'qa-router_get_tool_schema',
          description: 'Catalog:\n## stdio-mock\nAvailable tools:\nadd(a, b)\n',
        },
      },
      { function: { name: 'qa-router_invoke_tool', description: 'Invoke a tool.' } },
    ],
    messages: [{ role: 'user', content: 'Test the stdio mcp server' }],
    ...overrides,
  };
}

/**
 * Builds a request whose history carries one assistant tool call.
 *
 * @param name - The called tool name.
 * @param args - The raw arguments value.
 * @returns The request.
 */
function makeToolCallRequest(name: string, args: unknown): WireChatRequest {
  return makeRequest({
    messages: [
      { role: 'user', content: 'Test the stdio mcp server' },
      { role: 'assistant', tool_calls: [{ function: { name, arguments: args } }] },
    ],
  });
}

describe('runChecks', () => {
  it('returns no checks without expectations', () => {
    expect(runChecks(makeRequest(), undefined)).toEqual([]);
  });

  it('matches required tool names by exact name or underscore suffix', () => {
    const checks = runChecks(makeRequest(), {
      toolsContain: ['get_tool_schema', 'invoke_tool', 'missing_tool'],
    });
    expect(checks.map((check) => check.ok)).toEqual([true, true, false]);
    expect(checks[2].detail).toContain('qa-router_get_tool_schema');
  });

  it('matches tool names separated by a hyphen', () => {
    const request = makeRequest({
      tools: [
        { function: { name: 'qa-router-get_tool_schema', description: '## stdio-mock' } },
        { function: { name: 'qa-router-invoke_tool' } },
      ],
    });
    const checks = runChecks(request, {
      toolsContain: ['get_tool_schema', 'invoke_tool'],
      catalogIncludes: ['## stdio-mock'],
    });
    expect(checks.every((check) => check.ok)).toBe(true);
  });

  it('does not match a name inside an alphanumeric run', () => {
    const request = makeRequest({ tools: [{ function: { name: 'otherget_tool_schema' } }] });
    const checks = runChecks(request, { toolsContain: ['get_tool_schema'] });
    expect(checks[0].ok).toBe(false);
  });

  it('fails when a downstream tool is advertised directly', () => {
    const request = makeRequest({
      tools: [
        { function: { name: 'qa-router_get_tool_schema', description: '## stdio-mock' } },
        { function: { name: 'echo' } },
      ],
    });
    const checks = runChecks(request, { toolsAbsent: ['echo', 'add'] });
    expect(checks.map((check) => check.ok)).toEqual([false, true]);
  });

  it('checks the get_tool_schema catalog description', () => {
    const checks = runChecks(makeRequest(), {
      catalogIncludes: ['## stdio-mock', 'add(a, b)', '## other-server'],
    });
    expect(checks.map((check) => check.ok)).toEqual([true, true, false]);
    expect(checks[2].detail).toContain('## stdio-mock');
  });

  it('checks substrings that must be absent from the catalog', () => {
    const checks = runChecks(makeRequest(), {
      catalogExcludes: ['add(a, b)', 'LONG-DESCRIPTION-TAIL'],
    });
    expect(checks.map((check) => check.ok)).toEqual([false, true]);
  });

  it('fails an exclusion check when the catalog tool is missing', () => {
    const request = makeRequest({ tools: [{ function: { name: 'qa-router_invoke_tool' } }] });
    const checks = runChecks(request, { catalogExcludes: ['LONG-DESCRIPTION-TAIL'] });
    expect(checks[0].ok).toBe(false);
    expect(checks[0].detail).toContain('no get_tool_schema tool');
  });

  it('checks message texts including tool results', () => {
    const request = makeRequest({
      messages: [
        { role: 'user', content: 'Test the stdio mcp server' },
        { role: 'tool', content: '42' },
      ],
    });
    const checks = runChecks(request, { messagesInclude: ['42', '99'] });
    expect(checks.map((check) => check.ok)).toEqual([true, false]);
  });

  it('parses tool call arguments and checks compact JSON substrings', () => {
    const request = makeToolCallRequest('qa-router_invoke_tool', {
      server: 'stdio-mock',
      tool: 'add',
      arguments: { a: 20, b: 22 },
    });
    const checks = runChecks(request, {
      toolCallsInclude: [
        { name: 'invoke_tool', argumentsInclude: ['stdio-mock', '"a":20'] },
        { name: 'get_tool_schema' },
      ],
    });
    expect(checks.map((check) => check.ok)).toEqual([true, true, true, false]);
    expect(checks[3].detail).toContain('qa-router_invoke_tool');
  });

  it('parses JSON string arguments', () => {
    const request = makeToolCallRequest('qa-router_invoke_tool', '{"server":"stdio-mock"}');
    const checks = runChecks(request, {
      toolCallsInclude: [{ name: 'invoke_tool', argumentsInclude: ['stdio-mock'] }],
    });
    expect(checks.every((check) => check.ok)).toBe(true);
  });

  it('checks structured message content', () => {
    const request = makeRequest({
      messages: [{ role: 'tool', content: [{ type: 'text', text: 'long description tail' }] }],
    });
    const checks = runChecks(request, { messagesInclude: ['long description tail'] });
    expect(checks[0].ok).toBe(true);
  });
});

describe('resolveScriptedToolName', () => {
  it('resolves the generic script name to the advertised wire name', () => {
    const request = makeRequest({
      tools: [
        { function: { name: 'qa-router-get_tool_schema' } },
        { function: { name: 'qa-router-invoke_tool' } },
      ],
    });
    expect(resolveScriptedToolName(request, 'qa-router_get_tool_schema')).toBe(
      'qa-router-get_tool_schema',
    );
    expect(resolveScriptedToolName(request, 'qa-router_invoke_tool')).toBe('qa-router-invoke_tool');
  });

  it('keeps the scripted name when nothing matches', () => {
    expect(resolveScriptedToolName(makeRequest(), 'qa-router_unknown_tool')).toBe(
      'qa-router_unknown_tool',
    );
  });
});

describe('formatCheckFailures', () => {
  it('lists only the failed checks', () => {
    const checks = runChecks(makeRequest(), { toolsContain: ['get_tool_schema', 'nope'] });
    const message = formatCheckFailures(checks);
    expect(message).toContain('QA mock LLM validation failed:');
    expect(message).toContain('toolsContain "nope"');
    expect(message).not.toContain('toolsContain "get_tool_schema"');
  });
});
