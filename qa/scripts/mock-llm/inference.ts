/**
 * Inference pipeline of the QA mock LLM.
 *
 * Owns the scripted serving path shared by both wire protocols: pick the
 * current script step, run its expectation checks against the normalized
 * request, resolve the scripted tool name to the name the agent
 * advertised, advance the step, log the raw request and the served
 * response, and write the response through the protocol adapter.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { formatCheckFailures, runChecks, type CheckResult } from './checks.js';
import type { Completion } from './completions.js';
import { readBody, sendJson } from './http.js';
import type { LlmRequestLog, ResponseKind } from './log.js';
import type { ProtocolAdapter } from './protocol.js';
import type { MockLlmScript } from './scripts.js';
import { resolveToolStep, type WireChatRequest } from './tool-names.js';

const MODEL_ID = 'qa-mock';
const AUXILIARY_TEXT = 'QA mock session';
const EXHAUSTED_TEXT = 'The script has no more steps.';
const NO_SCRIPT_TEXT = 'No QA script selected. Run: pnpm qa:llm script <name>';

/** Mutable state shared by every request. */
export interface ServerState {
  /** Selected script, or null before one is chosen. */
  script: MockLlmScript | null;
  /** Index of the next main (tool-carrying) step to serve. */
  stepIndex: number;
  /** Raw request/response log. */
  log: LlmRequestLog;
}

/** Metadata attached to one served completion. */
interface CompletionMeta {
  kind: ResponseKind;
  stepIndex: number | null;
  auxiliary: boolean;
  checks: CheckResult[];
  streamed: boolean;
}

/**
 * Builds the script status payload used by `/health` and `/admin/status`.
 *
 * @param state - The mutable server state.
 * @returns The status payload.
 */
export function statusPayload(state: ServerState): Record<string, unknown> {
  return {
    ok: true,
    script: state.script?.name ?? null,
    stepIndex: state.stepIndex,
    steps: state.script?.steps.length ?? 0,
    requestCount: state.log.size,
  };
}

/**
 * Logs one served completion and writes it to the client.
 *
 * @param state - The mutable server state.
 * @param res - The server response.
 * @param requestBody - The raw request body to log.
 * @param completion - The completion to serve.
 * @param meta - Log metadata for the entry.
 * @param protocol - The adapter that renders the response.
 */
function serveCompletion(
  state: ServerState,
  res: ServerResponse,
  requestBody: unknown,
  completion: Completion,
  meta: CompletionMeta,
  protocol: ProtocolAdapter,
): void {
  const entry = state.log.add({
    auxiliary: meta.auxiliary,
    stepIndex: meta.stepIndex,
    request: requestBody,
    checks: meta.checks,
    response: { kind: meta.kind, body: completion.body, streamed: meta.streamed },
  });
  console.log(JSON.stringify(entry));
  protocol.write(res, completion, meta.streamed);
}

/**
 * Serves the no-script or exhausted-script fallback turn.
 *
 * @param state - The mutable server state.
 * @param res - The server response.
 * @param rawBody - The raw request body to log.
 * @param stream - True when the agent asked for SSE.
 * @param protocol - The adapter that renders the response.
 */
function serveUnavailable(
  state: ServerState,
  res: ServerResponse,
  rawBody: unknown,
  stream: boolean,
  protocol: ProtocolAdapter,
): void {
  const noScript = state.script === null;
  serveCompletion(
    state,
    res,
    rawBody,
    protocol.buildText(noScript ? NO_SCRIPT_TEXT : EXHAUSTED_TEXT, MODEL_ID),
    {
      kind: noScript ? 'no-script' : 'exhausted',
      stepIndex: null,
      auxiliary: false,
      checks: [],
      streamed: stream,
    },
    protocol,
  );
}

/**
 * Serves the failed-validation turn without advancing the script.
 *
 * @param state - The mutable server state.
 * @param res - The server response.
 * @param rawBody - The raw request body to log.
 * @param checks - The failed check results.
 * @param stream - True when the agent asked for SSE.
 * @param protocol - The adapter that renders the response.
 */
function serveValidationError(
  state: ServerState,
  res: ServerResponse,
  rawBody: unknown,
  checks: CheckResult[],
  stream: boolean,
  protocol: ProtocolAdapter,
): void {
  serveCompletion(
    state,
    res,
    rawBody,
    protocol.buildText(formatCheckFailures(checks), MODEL_ID),
    {
      kind: 'validation-error',
      stepIndex: state.stepIndex,
      auxiliary: false,
      checks,
      streamed: stream,
    },
    protocol,
  );
}

/**
 * Serves one main request against the current script step.
 *
 * @param state - The mutable server state.
 * @param res - The server response.
 * @param rawBody - The raw request body to log.
 * @param request - The normalized request the checks inspect.
 * @param stream - True when the agent asked for SSE.
 * @param protocol - The adapter that renders the response.
 */
function serveMainRequest(
  state: ServerState,
  res: ServerResponse,
  rawBody: unknown,
  request: WireChatRequest,
  stream: boolean,
  protocol: ProtocolAdapter,
): void {
  const step = state.script?.steps[state.stepIndex];
  if (state.script === null || step === undefined) {
    serveUnavailable(state, res, rawBody, stream, protocol);
    return;
  }
  const checks = runChecks(request, step.expect);
  if (checks.some((check) => !check.ok)) {
    serveValidationError(state, res, rawBody, checks, stream, protocol);
    return;
  }
  const toolStep = resolveToolStep(step, request);
  const completion = protocol.buildStep(toolStep, MODEL_ID, `call_qa_${state.log.size + 1}`);
  const kind: ResponseKind = 'tool' in step.respond ? 'tool' : 'text';
  const stepIndex = state.stepIndex;
  state.stepIndex += 1;
  serveCompletion(
    state,
    res,
    rawBody,
    completion,
    { kind, stepIndex, auxiliary: false, checks, streamed: stream },
    protocol,
  );
}

/**
 * Handles one inference request in the protocol's wire format.
 *
 * @param req - The incoming request.
 * @param res - The server response.
 * @param state - The mutable server state.
 * @param protocol - The adapter for the request's wire protocol.
 */
export async function handleInference(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState,
  protocol: ProtocolAdapter,
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: { message: 'invalid JSON body' } });
    return;
  }
  const { request, stream } = protocol.normalize(raw);
  if ((request.tools ?? []).length === 0) {
    serveCompletion(
      state,
      res,
      raw,
      protocol.buildText(AUXILIARY_TEXT, MODEL_ID),
      { kind: 'auxiliary', stepIndex: null, auxiliary: true, checks: [], streamed: stream },
      protocol,
    );
    return;
  }
  serveMainRequest(state, res, raw, request, stream, protocol);
}

/**
 * Handles an Anthropic `count_tokens` probe with a rough estimate.
 *
 * @param req - The incoming request.
 * @param res - The server response.
 */
export async function handleCountTokens(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown = null;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    body = null;
  }
  const text = body === null ? '' : JSON.stringify(body);
  sendJson(res, 200, { input_tokens: Math.max(1, Math.ceil(text.length / 4)) });
}
