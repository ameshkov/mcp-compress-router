/**
 * OpenAI Responses API support for the QA mock LLM.
 *
 * Codex CLI speaks the Responses API (`POST /v1/responses`, an `input`
 * item list instead of a message list, and `output` items instead of
 * choices), while opencode and Copilot CLI speak OpenAI chat
 * completions and Claude Code speaks the Anthropic Messages API. The
 * mock serves all three: this module normalizes Responses requests into
 * the shared `WireChatRequest` shape the expectation checks inspect, and
 * renders the scripted assistant turns back as Responses objects,
 * streamed or as plain JSON.
 *
 * Codex nests MCP tools inside namespace tools
 * (`{"type":"namespace","name":"mcp__qa_router","tools":[...]}`), so
 * normalization flattens the namespace children into the shared shape
 * with the namespace attached. A function call served back to Codex
 * must carry the namespace too, or the agent cannot dispatch it.
 *
 * The raw Responses request is what the mock logs, so the log always
 * shows exactly what Codex sent (including its built-in tools, its
 * namespace tools, and its `function_call`/`function_call_output`
 * history items).
 */
import type { ServerResponse } from 'node:http';
import {
  buildStepCompletion,
  buildTextCompletion,
  type AssistantMessage,
  type Completion,
} from './completions.js';
import type { NormalizedRequest, ProtocolAdapter } from './protocol.js';
import type { WireChatRequest, WireMessage, WireTool } from './tool-names.js';

/** Wire shape of one function tool in a Responses request. */
export interface ResponsesFunctionTool {
  type?: string;
  name?: string;
  description?: string;
  parameters?: unknown;
}

/** Wire shape of one namespace tool in a Responses request. */
export interface ResponsesNamespaceTool {
  type?: string;
  name?: string;
  description?: string;
  tools?: ResponsesFunctionTool[];
}

/** Wire shape of one tool in a Responses request. */
export type ResponsesTool = ResponsesFunctionTool | ResponsesNamespaceTool;

/**
 * Checks whether a tool is a namespace container.
 *
 * @param tool - The advertised tool.
 * @returns True for namespace tools.
 */
function isNamespaceTool(tool: ResponsesTool): tool is ResponsesNamespaceTool {
  return tool.type === 'namespace';
}

/**
 * Checks whether a tool is a plain function tool.
 *
 * @param tool - The advertised tool.
 * @returns True for function tools.
 */
function isFunctionTool(tool: ResponsesTool): tool is ResponsesFunctionTool {
  return tool.type === 'function';
}

/** Wire shape of one content part of a Responses message item. */
export interface ResponsesContentPart {
  type?: string;
  text?: string;
}

/** Wire shape of one input item in a Responses request. */
export interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: string | ResponsesContentPart[];
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: unknown;
}

/** The Responses request fields the mock inspects. */
export interface ResponsesRequest {
  model?: string;
  stream?: boolean;
  tools?: ResponsesTool[];
  input?: ResponsesInputItem[];
}

/** One output item of the Responses response the mock serves. */
interface ResponsesOutputItem {
  type: 'message' | 'function_call';
  id: string;
  status?: string;
  role?: string;
  content?: Array<{ type: 'output_text'; text: string; annotations: unknown[] }>;
  call_id?: string;
  namespace?: string;
  name?: string;
  arguments?: string;
}

/** The Responses body the mock logs and streams. */
interface ResponsesBody {
  id: string;
  output: ResponsesOutputItem[];
}

/**
 * Flattens one advertised tool into the shared wire shape.
 *
 * Namespace children keep their namespace so the checks can match them
 * by their qualified `<namespace>__<name>` wire name.
 *
 * @param tool - The advertised tool.
 * @returns The flattened tools, empty for non-function tools.
 */
function flattenTool(tool: ResponsesTool): WireTool[] {
  if (isNamespaceTool(tool)) {
    const namespace = tool.name ?? '';
    return (tool.tools ?? [])
      .filter((child) => child.name !== undefined)
      .map((child) => ({
        namespace,
        function: {
          name: child.name,
          description: child.description,
          parameters: child.parameters,
        },
      }));
  }
  if (isFunctionTool(tool)) {
    return [
      {
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      },
    ];
  }
  return [];
}

/**
 * Joins the text parts of a Responses content array.
 *
 * @param parts - The content parts.
 * @returns The joined text, or undefined when there are no text parts.
 */
function partsText(parts: ResponsesContentPart[]): string | undefined {
  const texts = parts
    .filter((part) => typeof part.text === 'string')
    .map((part) => part.text as string);
  return texts.length === 0 ? undefined : texts.join('\n');
}

/**
 * Normalizes one Responses input item.
 *
 * `function_call_output` content is kept as the original value so the
 * `messagesInclude` checks can still find the result text in it.
 *
 * @param item - The input item.
 * @returns The item in the shared shape, or undefined when it carries
 *   nothing the checks inspect.
 */
function normalizeInputItem(item: ResponsesInputItem): WireMessage | undefined {
  if (item.type === 'message') {
    if (typeof item.content === 'string' || item.content === undefined) {
      return { role: item.role, content: item.content };
    }
    return { role: item.role, content: partsText(item.content) ?? JSON.stringify(item.content) };
  }
  if (item.type === 'function_call') {
    return {
      role: 'assistant',
      tool_calls: [{ function: { name: item.name ?? '', arguments: item.arguments ?? '{}' } }],
    };
  }
  if (item.type === 'function_call_output') {
    return { role: 'tool', content: item.output };
  }
  return undefined;
}

/**
 * Normalizes a Responses request into the shared request shape.
 *
 * @param body - The parsed Responses request body.
 * @returns The request the expectation checks inspect.
 */
export function normalizeResponsesRequest(body: ResponsesRequest): WireChatRequest {
  return {
    stream: body.stream,
    tools: (body.tools ?? []).flatMap(flattenTool),
    messages: (body.input ?? [])
      .map(normalizeInputItem)
      .filter((message): message is WireMessage => message !== undefined),
  };
}

/**
 * Builds the output items of one assistant turn.
 *
 * @param message - The assistant message.
 * @returns The `message` or `function_call` output items.
 */
function outputItems(message: AssistantMessage): ResponsesOutputItem[] {
  const calls = message.tool_calls ?? [];
  if (calls.length > 0) {
    return calls.map((call, index) => {
      const item: ResponsesOutputItem = {
        type: 'function_call',
        id: `fc_qa_${index + 1}`,
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
        status: 'completed',
      };
      if (call.namespace !== undefined) {
        item.namespace = call.namespace;
      }
      return item;
    });
  }
  return [
    {
      type: 'message',
      id: 'msg_qa',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content ?? '', annotations: [] }],
    },
  ];
}

/**
 * Builds the Responses envelope for one assistant turn.
 *
 * @param message - The assistant message.
 * @param model - The model id to report.
 * @returns The completion carrying the Responses body.
 */
export function buildResponsesCompletion(message: AssistantMessage, model: string): Completion {
  return {
    body: {
      id: 'resp_qa',
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model,
      output: outputItems(message),
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
    message,
  };
}

/**
 * Writes one SSE event in the Responses streaming format.
 *
 * @param res - The server response.
 * @param event - The SSE event name.
 * @param data - The event payload.
 */
function writeEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Writes one Responses completion as SSE or plain JSON.
 *
 * Codex consumes `response.output_item.done` for every output item and
 * `response.completed` as the end of the turn; it does not require the
 * intermediate delta events.
 *
 * @param res - The server response.
 * @param completion - The completion to write.
 * @param stream - True for SSE, false for plain JSON.
 */
export function writeResponsesCompletion(
  res: ServerResponse,
  completion: Completion,
  stream: boolean,
): void {
  const body = completion.body as unknown as ResponsesBody;
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  writeEvent(res, 'response.created', { type: 'response.created', response: { id: body.id } });
  for (const item of body.output) {
    writeEvent(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      item,
    });
  }
  writeEvent(res, 'response.completed', { type: 'response.completed', response: body });
  res.end();
}

/** The OpenAI Responses API adapter used by Codex CLI. */
export const responsesProtocol: ProtocolAdapter = {
  name: 'responses',
  normalize: (body) => {
    const request = body as ResponsesRequest;
    const normalized: NormalizedRequest = {
      request: normalizeResponsesRequest(request),
      stream: request.stream !== false,
    };
    return normalized;
  },
  buildText: (text, model) =>
    buildResponsesCompletion(buildTextCompletion(text, model).message, model),
  buildStep: (step, model, callId) =>
    buildResponsesCompletion(buildStepCompletion(step, model, callId).message, model),
  write: writeResponsesCompletion,
};
