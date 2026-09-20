import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { llmBaseUrl, renderLogSummary, type LlmLog } from './client.js';

/**
 * Builds a one-request Codex-shaped log.
 *
 * @param responseBody - The logged Responses response body.
 * @returns The log payload.
 */
function makeCodexLog(responseBody: unknown): LlmLog {
  return {
    ok: true,
    script: 'stdio-catalog',
    stepIndex: 1,
    steps: 1,
    requestCount: 1,
    requests: [
      {
        index: 1,
        timestamp: '2026-09-20T00:00:00.000Z',
        auxiliary: false,
        stepIndex: 0,
        request: {
          tools: [
            { type: 'function', name: 'exec_command' },
            {
              type: 'namespace',
              name: 'mcp__qa_router',
              tools: [{ type: 'function', name: 'get_tool_schema' }],
            },
          ],
        },
        checks: [],
        response: { kind: 'tool', streamed: true, body: responseBody },
      },
    ],
  };
}

describe('llmBaseUrl', () => {
  const original = process.env.QA_LLM_URL;

  beforeEach(() => {
    delete process.env.QA_LLM_URL;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.QA_LLM_URL;
    } else {
      process.env.QA_LLM_URL = original;
    }
  });

  it('returns QA_LLM_URL without a trailing slash', () => {
    process.env.QA_LLM_URL = 'http://mock-llm:8080/';
    expect(llmBaseUrl()).toBe('http://mock-llm:8080');
  });

  it('throws when QA_LLM_URL is not set', () => {
    expect(() => llmBaseUrl()).toThrow(/QA_LLM_URL is not set/);
  });

  it('throws when QA_LLM_URL is blank', () => {
    process.env.QA_LLM_URL = '   ';
    expect(() => llmBaseUrl()).toThrow(/QA_LLM_URL is not set/);
  });
});

describe('renderLogSummary', () => {
  it('lists Codex namespace children by their qualified names', () => {
    const rendered = renderLogSummary(makeCodexLog({ output: [] }));
    expect(rendered).toContain('exec_command, mcp__qa_router__get_tool_schema');
    expect(rendered).not.toContain('tools (2): mcp__qa_router');
  });

  it('renders a Responses function call with its namespace', () => {
    const rendered = renderLogSummary(
      makeCodexLog({
        output: [
          {
            type: 'function_call',
            namespace: 'mcp__qa_router',
            name: 'get_tool_schema',
            arguments: '{"server":"stdio-mock"}',
          },
        ],
      }),
    );
    expect(rendered).toContain('tool mcp__qa_router__get_tool_schema {"server":"stdio-mock"}');
  });

  it('renders a Responses text turn', () => {
    const rendered = renderLogSummary(
      makeCodexLog({
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }],
          },
        ],
      }),
    );
    expect(rendered).toContain('text "done"');
  });
});
