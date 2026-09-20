/**
 * Anthropic Messages API support for the QA mock LLM.
 *
 * Claude Code speaks the Anthropic Messages API (`POST /v1/messages`,
 * tools carrying `input_schema`, and `tool_use`/`tool_result` content
 * blocks), while opencode and Copilot CLI speak OpenAI chat
 * completions. The mock serves both: this module normalizes Anthropic
 * requests into the shared `WireChatRequest` shape the expectation
 * checks inspect, and renders the scripted assistant turns back as
 * Anthropic messages, streamed or as plain JSON.
 *
 * The raw Anthropic request is what the mock logs, so the log always
 * shows exactly what Claude Code sent (including its built-in tools and
 * its `mcp__<server>__<tool>` MCP tool names).
 */
import type { ServerResponse } from 'node:http';
import {
  buildStepCompletion,
  buildTextCompletion,
  type AssistantMessage,
  type Completion,
} from './completions.js';
import type { NormalizedRequest, ProtocolAdapter } from './protocol.js';
import type { WireChatRequest, WireMessage, WireTool, WireToolCall } from './tool-names.js';

/** Wire shape of one tool definition in an Anthropic request. */
export interface AnthropicTool {
  name?: string;
  description?: string;
  input_schema?: unknown;
}

/** Wire shape of one content block in an Anthropic message. */
export interface AnthropicBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

/** Wire shape of one message in an Anthropic request. */
export interface AnthropicMessage {
  role?: string;
  content?: string | AnthropicBlock[];
}

/** The Anthropic request fields the mock inspects. */
export interface AnthropicRequest {
  model?: string;
  stream?: boolean;
  tools?: AnthropicTool[];
  messages?: AnthropicMessage[];
}

/** One content block of the Anthropic response the mock serves. */
interface AnthropicResponseBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/** The Anthropic message body the mock logs and streams. */
interface AnthropicMessageBody {
  id: string;
  model: string;
  content: AnthropicResponseBlock[];
  stop_reason: string;
}

/**
 * Joins the text blocks of an Anthropic content array.
 *
 * @param blocks - The content blocks.
 * @returns The joined text, or null when there are no text blocks.
 */
function textOf(blocks: AnthropicBlock[]): string | null {
  const parts = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
  return parts.length === 0 ? null : parts.join('\n');
}

/**
 * Converts the `tool_use` blocks into OpenAI-style tool calls.
 *
 * @param blocks - The content blocks.
 * @returns The tool calls, or undefined when there are none.
 */
function toolCallsOf(blocks: AnthropicBlock[]): WireToolCall[] | undefined {
  const calls = blocks
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      function: { name: block.name ?? '', arguments: JSON.stringify(block.input ?? {}) },
    }));
  return calls.length === 0 ? undefined : calls;
}

/**
 * Normalizes one Anthropic message.
 *
 * `tool_result` content is kept as the original block array so the
 * `messagesInclude` checks can still find the result text in it.
 *
 * @param message - The Anthropic message.
 * @returns The message in the shared shape.
 */
function normalizeMessage(message: AnthropicMessage): WireMessage {
  if (typeof message.content === 'string' || message.content === undefined) {
    return { role: message.role, content: message.content };
  }
  const blocks = message.content;
  const normalized: WireMessage = { role: message.role };
  normalized.content = blocks.some((block) => block.type === 'tool_result')
    ? blocks
    : textOf(blocks);
  const calls = toolCallsOf(blocks);
  if (calls !== undefined) {
    normalized.tool_calls = calls;
  }
  return normalized;
}

/**
 * Normalizes an Anthropic request into the shared request shape.
 *
 * @param body - The parsed Anthropic request body.
 * @returns The request the expectation checks inspect.
 */
export function normalizeAnthropicRequest(body: AnthropicRequest): WireChatRequest {
  const tools: WireTool[] = (body.tools ?? []).map((tool) => ({
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  }));
  return {
    stream: body.stream,
    tools,
    messages: (body.messages ?? []).map(normalizeMessage),
  };
}

/**
 * Parses the JSON arguments of an internal tool call.
 *
 * @param raw - The serialized arguments.
 * @returns The parsed value, or an empty object when it is not JSON.
 */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Converts the internal assistant message into Anthropic content blocks.
 *
 * @param message - The assistant message.
 * @returns The content blocks in wire order.
 */
function responseContent(message: AssistantMessage): AnthropicResponseBlock[] {
  const blocks: AnthropicResponseBlock[] = [];
  if (message.content !== null && message.content !== '') {
    blocks.push({ type: 'text', text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
    });
  }
  return blocks;
}

/**
 * Builds the Anthropic `message` envelope for one assistant turn.
 *
 * @param message - The assistant message.
 * @param model - The model id to report.
 * @returns The completion carrying the Anthropic body.
 */
export function buildAnthropicCompletion(message: AssistantMessage, model: string): Completion {
  return {
    body: {
      id: 'msg_qa',
      type: 'message',
      role: 'assistant',
      model,
      content: responseContent(message),
      stop_reason: message.tool_calls === undefined ? 'end_turn' : 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    message,
  };
}

/**
 * Writes one SSE event in the Anthropic streaming format.
 *
 * @param res - The server response.
 * @param event - The SSE event name.
 * @param data - The event payload.
 */
function writeEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Writes one content block as its start/delta/stop SSE events.
 *
 * @param res - The server response.
 * @param block - The content block.
 * @param index - The block index.
 */
function writeBlock(res: ServerResponse, block: AnthropicResponseBlock, index: number): void {
  if (block.type === 'text') {
    writeEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    });
    writeEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text: block.text ?? '' },
    });
  } else {
    writeEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
    });
    writeEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
    });
  }
  writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index });
}

/**
 * Streams one Anthropic message as SSE events.
 *
 * @param res - The server response.
 * @param body - The Anthropic message body.
 */
function writeAnthropicStream(res: ServerResponse, body: AnthropicMessageBody): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  writeEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      ...body,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  body.content.forEach((block, index) => writeBlock(res, block, index));
  writeEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: body.stop_reason, stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  writeEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

/**
 * Writes one Anthropic completion as SSE or plain JSON.
 *
 * @param res - The server response.
 * @param completion - The completion to write.
 * @param stream - True for SSE, false for plain JSON.
 */
export function writeAnthropicCompletion(
  res: ServerResponse,
  completion: Completion,
  stream: boolean,
): void {
  const body = completion.body as unknown as AnthropicMessageBody;
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  writeAnthropicStream(res, body);
}

/** The Anthropic Messages API adapter. */
export const anthropicProtocol: ProtocolAdapter = {
  name: 'anthropic',
  normalize: (body) => {
    const request = body as AnthropicRequest;
    const normalized: NormalizedRequest = {
      request: normalizeAnthropicRequest(request),
      stream: request.stream !== false,
    };
    return normalized;
  },
  buildText: (text, model) =>
    buildAnthropicCompletion(buildTextCompletion(text, model).message, model),
  buildStep: (step, model, callId) =>
    buildAnthropicCompletion(buildStepCompletion(step, model, callId).message, model),
  write: writeAnthropicCompletion,
};
