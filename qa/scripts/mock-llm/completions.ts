/**
 * OpenAI-compatible chat completion bodies and streaming for the QA
 * mock LLM.
 *
 * The mock builds a regular `chat.completion` object for every turn and
 * can serve it either as plain JSON or as an SSE stream, so the raw
 * request/response log always carries the same, readable body shape
 * regardless of how the coding agent asked for it.
 */
import type { ServerResponse } from 'node:http';
import type { ProtocolAdapter } from './protocol.js';
import type { ScriptStep } from './scripts.js';
import type { WireChatRequest } from './tool-names.js';

/** One assembled assistant message. */
export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
    /**
     * Namespace the called function lives in, when the agent nests its
     * tools (Codex CLI's Responses API). Other protocols ignore it.
     */
    namespace?: string;
  }>;
}

/** One assembled chat completion plus the message it carries. */
export interface Completion {
  /** The full `chat.completion` body (also logged by the server). */
  body: Record<string, unknown>;
  /** The assistant message inside the body. */
  message: AssistantMessage;
}

/**
 * Builds the completion envelope around an assistant message.
 *
 * @param message - The assistant message.
 * @param model - The model id to report.
 * @returns The completion and its message.
 */
function wrap(message: AssistantMessage, model: string): Completion {
  return {
    body: {
      id: 'chatcmpl-qa',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: message.tool_calls === undefined ? 'stop' : 'tool_calls',
        },
      ],
    },
    message,
  };
}

/**
 * Builds a plain text completion.
 *
 * @param text - The assistant text.
 * @param model - The model id to report.
 * @returns The completion.
 */
export function buildTextCompletion(text: string, model: string): Completion {
  return wrap({ role: 'assistant', content: text }, model);
}

/**
 * Builds a tool-call completion from one script step.
 *
 * @param step - The script step to serve.
 * @param model - The model id to report.
 * @param callId - The tool call id.
 * @returns The completion.
 */
export function buildToolCompletion(
  step: ScriptStep & {
    respond: { tool: { name: string; arguments: Record<string, unknown>; namespace?: string } };
  },
  model: string,
  callId: string,
): Completion {
  const call: NonNullable<AssistantMessage['tool_calls']>[number] = {
    id: callId,
    type: 'function',
    function: {
      name: step.respond.tool.name,
      arguments: JSON.stringify(step.respond.tool.arguments),
    },
  };
  if (step.respond.tool.namespace !== undefined) {
    call.namespace = step.respond.tool.namespace;
  }
  return wrap({ role: 'assistant', content: null, tool_calls: [call] }, model);
}

/**
 * Builds the completion for one script step.
 *
 * @param step - The script step to serve.
 * @param model - The model id to report.
 * @param callId - The tool call id used when the step is a tool turn.
 * @returns The completion.
 */
export function buildStepCompletion(step: ScriptStep, model: string, callId: string): Completion {
  if ('tool' in step.respond) {
    return buildToolCompletion(
      step as ScriptStep & {
        respond: { tool: { name: string; arguments: Record<string, unknown>; namespace?: string } };
      },
      model,
      callId,
    );
  }
  return buildTextCompletion(step.respond.text, model);
}

/**
 * Builds the SSE chunks for one completion.
 *
 * @param completion - The completion to stream.
 * @returns The chunks in wire order.
 */
function streamChunks(completion: Completion): Array<Record<string, unknown>> {
  const base = {
    id: completion.body.id,
    object: 'chat.completion.chunk',
    created: completion.body.created,
    model: completion.body.model,
  };
  const message = completion.message;
  const chunks: Array<Record<string, unknown>> = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
  ];
  if (message.tool_calls !== undefined) {
    const call = message.tool_calls[0];
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: call.id, type: 'function', function: call.function }],
          },
        },
      ],
    });
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { content: message.content ?? '' } }],
    });
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  return chunks;
}

/**
 * Writes one completion as an SSE stream.
 *
 * @param res - The server response.
 * @param completion - The completion to stream.
 */
export function writeStream(res: ServerResponse, completion: Completion): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const chunk of streamChunks(completion)) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Writes one completion as plain JSON.
 *
 * @param res - The server response.
 * @param completion - The completion to write.
 */
export function writeJson(res: ServerResponse, completion: Completion): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(completion.body));
}

/**
 * Writes one completion in the format the agent asked for.
 *
 * @param res - The server response.
 * @param completion - The completion to write.
 * @param stream - True for SSE, false for plain JSON.
 */
export function writeCompletion(
  res: ServerResponse,
  completion: Completion,
  stream: boolean,
): void {
  if (stream) {
    writeStream(res, completion);
  } else {
    writeJson(res, completion);
  }
}

/** The OpenAI chat completions adapter. */
export const openaiProtocol: ProtocolAdapter = {
  name: 'openai',
  normalize: (body) => {
    const request = body as WireChatRequest;
    return { request, stream: request.stream !== false };
  },
  buildText: buildTextCompletion,
  buildStep: buildStepCompletion,
  write: writeCompletion,
};
