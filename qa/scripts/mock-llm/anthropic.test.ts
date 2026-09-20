import { describe, expect, it } from 'vitest';
import {
  buildAnthropicCompletion,
  normalizeAnthropicRequest,
  type AnthropicRequest,
} from './anthropic.js';
import { runChecks } from './checks.js';

/**
 * Builds a request shaped like the one Claude Code sends.
 *
 * @param overrides - Fields to replace on the default request.
 * @returns The request.
 */
function makeAnthropicRequest(overrides: Partial<AnthropicRequest> = {}): AnthropicRequest {
  return {
    model: 'qa-mock',
    stream: true,
    tools: [
      {
        name: 'mcp__qa-router__get_tool_schema',
        description: 'Catalog:\n## stdio-mock\nAvailable tools:\nadd(a, b)',
        input_schema: { type: 'object' },
      },
      { name: 'mcp__qa-router__invoke_tool', description: 'Invoke a tool.' },
    ],
    messages: [{ role: 'user', content: 'Test the stdio mcp server' }],
    ...overrides,
  };
}

describe('normalizeAnthropicRequest', () => {
  it('converts tools with input_schema into the shared wire shape', () => {
    const request = normalizeAnthropicRequest(makeAnthropicRequest());
    expect(request.tools?.[0]).toEqual({
      function: {
        name: 'mcp__qa-router__get_tool_schema',
        description: 'Catalog:\n## stdio-mock\nAvailable tools:\nadd(a, b)',
        parameters: { type: 'object' },
      },
    });
    expect(request.stream).toBe(true);
  });

  it('converts tool_use blocks into recorded tool calls', () => {
    const request = normalizeAnthropicRequest(
      makeAnthropicRequest({
        messages: [
          { role: 'user', content: 'Test the stdio mcp server' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'mcp__qa-router__get_tool_schema',
                input: { server: 'stdio-mock' },
              },
            ],
          },
        ],
      }),
    );
    expect(request.messages?.[1].tool_calls).toEqual([
      {
        function: {
          name: 'mcp__qa-router__get_tool_schema',
          arguments: '{"server":"stdio-mock"}',
        },
      },
    ]);
  });

  it('keeps tool_result content searchable', () => {
    const request = normalizeAnthropicRequest(
      makeAnthropicRequest({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_1',
                content: [{ type: 'text', text: '42' }],
              },
            ],
          },
        ],
      }),
    );
    const checks = runChecks(request, { messagesInclude: ['42', '99'] });
    expect(checks.map((check) => check.ok)).toEqual([true, false]);
  });

  it('joins text blocks and ignores thinking blocks', () => {
    const request = normalizeAnthropicRequest(
      makeAnthropicRequest({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'hidden' },
              { type: 'text', text: 'first' },
              { type: 'text', text: 'second' },
            ],
          },
        ],
      }),
    );
    expect(request.messages?.[0].content).toBe('first\nsecond');
  });

  it('matches Claude Code MCP tool names in the checks', () => {
    const request = normalizeAnthropicRequest(makeAnthropicRequest());
    const checks = runChecks(request, {
      toolsContain: ['get_tool_schema', 'invoke_tool'],
      toolsAbsent: ['echo'],
      catalogIncludes: ['## stdio-mock'],
      catalogExcludes: ['LONG-DESCRIPTION-TAIL'],
    });
    expect(checks.every((check) => check.ok)).toBe(true);
  });
});

describe('buildAnthropicCompletion', () => {
  it('renders a text turn as an end_turn message', () => {
    const completion = buildAnthropicCompletion({ role: 'assistant', content: 'done' }, 'qa-mock');
    const body = completion.body;
    expect(body.type).toBe('message');
    expect(body.stop_reason).toBe('end_turn');
    expect(body.content).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('renders a tool turn with parsed input', () => {
    const completion = buildAnthropicCompletion(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_qa_1',
            type: 'function',
            function: {
              name: 'mcp__qa-router__invoke_tool',
              arguments: '{"server":"stdio-mock"}',
            },
          },
        ],
      },
      'qa-mock',
    );
    expect(completion.body.stop_reason).toBe('tool_use');
    expect(completion.body.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_qa_1',
        name: 'mcp__qa-router__invoke_tool',
        input: { server: 'stdio-mock' },
      },
    ]);
  });
});
