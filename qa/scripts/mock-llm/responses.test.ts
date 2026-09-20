import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { runChecks } from './checks.js';
import {
  buildResponsesCompletion,
  normalizeResponsesRequest,
  writeResponsesCompletion,
  type ResponsesRequest,
} from './responses.js';
import { resolveToolStep } from './tool-names.js';
import type { ScriptStep } from './scripts.js';

/** Minimal ServerResponse double that records everything written. */
class FakeResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];

  /**
   * Records the status and headers.
   *
   * @param status - The status code.
   * @param headers - The response headers.
   */
  writeHead(status: number, headers: Record<string, string>): void {
    this.statusCode = status;
    this.headers = headers;
  }

  /**
   * Records a written chunk.
   *
   * @param chunk - The chunk.
   * @returns True, as Node does.
   */
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  /**
   * Records the final chunk, if any.
   *
   * @param chunk - The final chunk.
   */
  end(chunk?: string): void {
    if (chunk !== undefined) {
      this.chunks.push(chunk);
    }
  }

  /**
   * Returns everything written so far.
   *
   * @returns The response body.
   */
  get text(): string {
    return this.chunks.join('');
  }
}

/**
 * Builds a request shaped like the one Codex CLI sends.
 *
 * @param overrides - Fields to replace on the default request.
 * @returns The request.
 */
function makeResponsesRequest(overrides: Partial<ResponsesRequest> = {}): ResponsesRequest {
  return {
    model: 'qa-mock',
    stream: true,
    tools: [
      { type: 'function', name: 'exec_command', description: 'Runs a command.' },
      { type: 'web_search' },
      {
        type: 'namespace',
        name: 'mcp__qa_router',
        description: 'Tools in the mcp__qa_router namespace.',
        tools: [
          {
            type: 'function',
            name: 'get_tool_schema',
            description: 'Catalog:\n## stdio-mock\nAvailable tools:\nadd(a, b)',
            parameters: { type: 'object' },
          },
          { type: 'function', name: 'invoke_tool', description: 'Invoke a tool.' },
        ],
      },
    ],
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add 20 + 22' }] },
    ],
    ...overrides,
  };
}

describe('normalizeResponsesRequest', () => {
  it('flattens namespace tools with their namespace attached', () => {
    const request = normalizeResponsesRequest(makeResponsesRequest());
    expect(request.tools).toEqual([
      { function: { name: 'exec_command', description: 'Runs a command.', parameters: undefined } },
      {
        namespace: 'mcp__qa_router',
        function: {
          name: 'get_tool_schema',
          description: 'Catalog:\n## stdio-mock\nAvailable tools:\nadd(a, b)',
          parameters: { type: 'object' },
        },
      },
      {
        namespace: 'mcp__qa_router',
        function: { name: 'invoke_tool', description: 'Invoke a tool.', parameters: undefined },
      },
    ]);
    expect(request.stream).toBe(true);
  });

  it('matches namespaced MCP tools and the catalog description in the checks', () => {
    const request = normalizeResponsesRequest(makeResponsesRequest());
    const checks = runChecks(request, {
      toolsContain: ['get_tool_schema', 'invoke_tool'],
      toolsAbsent: ['echo', 'add'],
      catalogIncludes: ['## stdio-mock', 'add(a, b)'],
      catalogExcludes: ['LONG-DESCRIPTION-TAIL'],
    });
    expect(checks.every((check) => check.ok)).toBe(true);
  });

  it('normalizes message content parts and plain strings', () => {
    const request = normalizeResponsesRequest(
      makeResponsesRequest({
        input: [
          { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'one' }] },
          { type: 'message', role: 'user', content: 'plain text' },
        ],
      }),
    );
    expect(request.messages).toEqual([
      { role: 'developer', content: 'one' },
      { role: 'user', content: 'plain text' },
    ]);
  });

  it('converts function_call items into recorded tool calls', () => {
    const request = normalizeResponsesRequest(
      makeResponsesRequest({
        input: [
          {
            type: 'function_call',
            name: 'get_tool_schema',
            arguments: '{"server":"stdio-mock","tools":["add"]}',
          },
        ],
      }),
    );
    expect(request.messages?.[0].tool_calls).toEqual([
      {
        function: {
          name: 'get_tool_schema',
          arguments: '{"server":"stdio-mock","tools":["add"]}',
        },
      },
    ]);
  });

  it('keeps function_call_output content searchable', () => {
    const request = normalizeResponsesRequest(
      makeResponsesRequest({
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_qa_1',
            output: [{ type: 'input_text', text: '42' }],
          },
        ],
      }),
    );
    const checks = runChecks(request, { messagesInclude: ['42', '99'] });
    expect(checks.map((check) => check.ok)).toEqual([true, false]);
  });

  it('checks recorded tool calls and arguments', () => {
    const request = normalizeResponsesRequest(
      makeResponsesRequest({
        input: [
          {
            type: 'function_call',
            name: 'invoke_tool',
            arguments: '{"server":"stdio-mock","tool":"add","arguments":{"a":20,"b":22}}',
          },
        ],
      }),
    );
    const checks = runChecks(request, {
      toolCallsInclude: [
        { name: 'invoke_tool', argumentsInclude: ['stdio-mock', '"a":20'] },
        { name: 'get_tool_schema' },
      ],
    });
    expect(checks.map((check) => check.ok)).toEqual([true, true, true, false]);
  });

  it('ignores input items the checks do not inspect', () => {
    const request = normalizeResponsesRequest(
      makeResponsesRequest({
        input: [
          { type: 'reasoning' },
          { type: 'message', role: 'user', content: 'kept' },
          { type: 'unknown_item' },
        ],
      }),
    );
    expect(request.messages).toEqual([{ role: 'user', content: 'kept' }]);
  });
});

describe('resolveToolStep', () => {
  it('resolves a namespaced MCP call to the inner name and namespace', () => {
    const request = normalizeResponsesRequest(makeResponsesRequest());
    const step: ScriptStep = {
      respond: {
        tool: { name: 'qa-router_get_tool_schema', arguments: { server: 'stdio-mock' } },
      },
    };
    const resolved = resolveToolStep(step, request);
    expect('tool' in resolved.respond && resolved.respond.tool).toEqual({
      name: 'get_tool_schema',
      arguments: { server: 'stdio-mock' },
      namespace: 'mcp__qa_router',
    });
  });
});

describe('buildResponsesCompletion', () => {
  it('renders a text turn as a message output item', () => {
    const completion = buildResponsesCompletion({ role: 'assistant', content: 'done' }, 'qa-mock');
    expect(completion.body.status).toBe('completed');
    expect(completion.body.output).toEqual([
      {
        type: 'message',
        id: 'msg_qa',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'done', annotations: [] }],
      },
    ]);
  });

  it('renders a tool turn as a namespaced function call', () => {
    const completion = buildResponsesCompletion(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_qa_1',
            type: 'function',
            namespace: 'mcp__qa_router',
            function: { name: 'get_tool_schema', arguments: '{"server":"stdio-mock"}' },
          },
        ],
      },
      'qa-mock',
    );
    expect(completion.body.output).toEqual([
      {
        type: 'function_call',
        id: 'fc_qa_1',
        call_id: 'call_qa_1',
        namespace: 'mcp__qa_router',
        name: 'get_tool_schema',
        arguments: '{"server":"stdio-mock"}',
        status: 'completed',
      },
    ]);
  });
});

describe('writeResponsesCompletion', () => {
  it('streams response.created, the output item, and response.completed', () => {
    const res = new FakeResponse();
    const completion = buildResponsesCompletion({ role: 'assistant', content: 'done' }, 'qa-mock');
    writeResponsesCompletion(res as unknown as ServerResponse, completion, true);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.text).toContain('event: response.created');
    expect(res.text).toContain('event: response.output_item.done');
    expect(res.text).toContain('"type":"output_text","text":"done"');
    expect(res.text).toContain('event: response.completed');
  });

  it('writes the plain response body when not streaming', () => {
    const res = new FakeResponse();
    const completion = buildResponsesCompletion({ role: 'assistant', content: 'done' }, 'qa-mock');
    writeResponsesCompletion(res as unknown as ServerResponse, completion, false);
    expect(res.headers['content-type']).toBe('application/json');
    const body = JSON.parse(res.text) as { output: unknown[] };
    expect(body.output).toHaveLength(1);
  });
});
