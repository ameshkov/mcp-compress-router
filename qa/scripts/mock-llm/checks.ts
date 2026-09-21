/**
 * Expectation checks for the QA mock LLM.
 *
 * The mock verifies every incoming model request against the current
 * script step before serving it. The checks are what make the mock LLM
 * the primary verification point of the manual tests: they assert that
 * the coding agent advertised exactly the router's tools, that the
 * `get_tool_schema` description carries the downstream catalog, and that
 * the agent sent the scripted tool calls with the expected arguments.
 *
 * Tool names are matched exactly or by suffix after a non-alphanumeric
 * separator, so a check written as `get_tool_schema` matches both
 * `qa-router_get_tool_schema` (opencode), `qa-router-get_tool_schema`
 * (Copilot CLI), and `mcp__qa-router__get_tool_schema` (Claude Code)
 * and does not depend on the host's MCP server key or on the agent's
 * tool-name prefix separator.
 */
import type { ExpectedToolCall, StepExpectation } from './scripts.js';
import { matchesName, toolNames, wireToolName, type WireChatRequest } from './tool-names.js';

/** Outcome of one expectation check. */
export interface CheckResult {
  /** Check family, e.g. `toolsContain` or `catalogIncludes`. */
  kind: string;
  /** The expected item this check verifies. */
  target: string;
  /** True when the expectation held. */
  ok: boolean;
  /** What was actually seen; useful when the check failed. */
  detail: string;
}

/** Maximum length of an actual-value excerpt in a check detail. */
const DETAIL_LIMIT = 300;

/**
 * Truncates a value for a check detail line.
 *
 * @param value - The value to summarize.
 * @returns A single-line excerpt.
 */
function summarize(value: string): string {
  const singleLine = value.replaceAll('\n', ' ');
  return singleLine.length > DETAIL_LIMIT
    ? `${singleLine.slice(0, DETAIL_LIMIT)}... (${singleLine.length} chars)`
    : singleLine;
}

/**
 * Returns the description of the `get_tool_schema` tool.
 *
 * @param request - The parsed model request.
 * @returns The description, or undefined when the tool is absent.
 */
function catalogDescription(request: WireChatRequest): string | undefined {
  const tool = (request.tools ?? []).find((candidate) =>
    matchesName(wireToolName(candidate), 'get_tool_schema'),
  );
  return tool?.function?.description;
}

/**
 * Collects every message text and tool-call argument string.
 *
 * String content is used as-is; structured content (for example the
 * content-part arrays some agents send for tool results) is serialized
 * to JSON so substring checks can still find the text.
 *
 * @param request - The parsed model request.
 * @returns The searchable texts in message order.
 */
function messageTexts(request: WireChatRequest): string[] {
  const texts: string[] = [];
  for (const message of request.messages ?? []) {
    if (typeof message.content === 'string') {
      texts.push(message.content);
    } else if (message.content !== undefined && message.content !== null) {
      texts.push(JSON.stringify(message.content));
    }
    for (const call of message.tool_calls ?? []) {
      const args = call.function?.arguments;
      texts.push(typeof args === 'string' ? args : JSON.stringify(args ?? {}));
    }
  }
  return texts;
}

/**
 * Normalizes one tool call's arguments to compact JSON.
 *
 * @param args - The raw `function.arguments` value.
 * @returns A compact JSON string.
 */
function compactArguments(args: unknown): string {
  if (typeof args !== 'string') {
    return JSON.stringify(args ?? {});
  }
  try {
    return JSON.stringify(JSON.parse(args));
  } catch {
    return args;
  }
}

/**
 * Collects every tool call recorded in the message history.
 *
 * @param request - The parsed model request.
 * @returns The recorded calls with normalized arguments.
 */
function recordedToolCalls(request: WireChatRequest): Array<{ name: string; args: string }> {
  const calls: Array<{ name: string; args: string }> = [];
  for (const message of request.messages ?? []) {
    for (const call of message.tool_calls ?? []) {
      calls.push({
        name: call.function?.name ?? '',
        args: compactArguments(call.function?.arguments),
      });
    }
  }
  return calls;
}

/**
 * Checks the required tool names.
 *
 * @param request - The parsed model request.
 * @param expected - Tool names that must be present.
 * @returns One result per expected name.
 */
function checkToolsContain(
  request: WireChatRequest,
  expected: string[] | undefined,
): CheckResult[] {
  const names = toolNames(request);
  return (expected ?? []).map((target) => ({
    kind: 'toolsContain',
    target,
    ok: names.some((name) => matchesName(name, target)),
    detail: `advertised: ${names.join(', ')}`,
  }));
}

/**
 * Checks the forbidden tool names.
 *
 * @param request - The parsed model request.
 * @param expected - Tool names that must be absent.
 * @returns One result per expected name.
 */
function checkToolsAbsent(request: WireChatRequest, expected: string[] | undefined): CheckResult[] {
  const names = toolNames(request);
  return (expected ?? []).map((target) => ({
    kind: 'toolsAbsent',
    target,
    ok: !names.some((name) => matchesName(name, target)),
    detail: `advertised: ${names.join(', ')}`,
  }));
}

/**
 * Checks the `get_tool_schema` catalog description.
 *
 * @param request - The parsed model request.
 * @param expected - Substrings that must appear in the description.
 * @returns One result per expected substring.
 */
function checkCatalog(request: WireChatRequest, expected: string[] | undefined): CheckResult[] {
  const description = catalogDescription(request);
  return (expected ?? []).map((target) => ({
    kind: 'catalogIncludes',
    target,
    ok: description !== undefined && description.includes(target),
    detail:
      description === undefined
        ? 'no get_tool_schema tool in the request'
        : `catalog: ${summarize(description)}`,
  }));
}

/**
 * Checks substrings that must be absent from the catalog description.
 *
 * Agents truncate tool descriptions at their own limits (Claude Code
 * cuts at 2048 characters and appends `… [truncated]`), so a plan can
 * assert that a marker past the limit never reaches the model in the
 * catalog.
 *
 * @param request - The parsed model request.
 * @param expected - Substrings that must be absent.
 * @returns One result per expected substring.
 */
function checkCatalogExcludes(
  request: WireChatRequest,
  expected: string[] | undefined,
): CheckResult[] {
  const description = catalogDescription(request);
  return (expected ?? []).map((target) => ({
    kind: 'catalogExcludes',
    target,
    ok: description !== undefined && !description.includes(target),
    detail:
      description === undefined
        ? 'no get_tool_schema tool in the request'
        : `catalog: ${summarize(description)}`,
  }));
}

/**
 * Checks substrings anywhere in the message history.
 *
 * @param request - The parsed model request.
 * @param expected - Substrings that must appear.
 * @returns One result per expected substring.
 */
function checkMessages(request: WireChatRequest, expected: string[] | undefined): CheckResult[] {
  const texts = messageTexts(request);
  return (expected ?? []).map((target) => ({
    kind: 'messagesInclude',
    target,
    ok: texts.some((text) => text.includes(target)),
    detail: `${texts.length} message text(s), ${texts.filter((text) => text.includes(target)).length} match(es)`,
  }));
}

/**
 * Checks one expected tool call and its arguments.
 *
 * @param calls - The calls recorded in the message history.
 * @param expected - The expected call.
 * @returns One result per expected call or argument substring.
 */
function checkOneToolCall(
  calls: Array<{ name: string; args: string }>,
  expected: ExpectedToolCall,
): CheckResult[] {
  const matching = calls.filter((call) => matchesName(call.name, expected.name));
  if (matching.length === 0) {
    return [
      {
        kind: 'toolCallsInclude',
        target: expected.name,
        ok: false,
        detail: `recorded calls: ${calls.map((call) => call.name).join(', ') || '(none)'}`,
      },
    ];
  }
  const results: CheckResult[] = [
    {
      kind: 'toolCallsInclude',
      target: expected.name,
      ok: true,
      detail: `${matching.length} call(s)`,
    },
  ];
  for (const argument of expected.argumentsInclude ?? []) {
    results.push({
      kind: 'toolCallsInclude',
      target: `${expected.name}(${argument})`,
      ok: matching.some((call) => call.args.includes(argument)),
      detail: `arguments: ${summarize(matching.map((call) => call.args).join(' | '))}`,
    });
  }
  return results;
}

/**
 * Checks the expected tool calls in the message history.
 *
 * @param request - The parsed model request.
 * @param expected - Tool calls that must appear.
 * @returns One result per expected call or argument substring.
 */
function checkToolCalls(
  request: WireChatRequest,
  expected: ExpectedToolCall[] | undefined,
): CheckResult[] {
  const calls = recordedToolCalls(request);
  return (expected ?? []).flatMap((call) => checkOneToolCall(calls, call));
}

/**
 * Runs every expectation for one script step.
 *
 * @param request - The parsed model request.
 * @param expect - The step expectations, if any.
 * @returns The check results in a stable order.
 */
export function runChecks(
  request: WireChatRequest,
  expect: StepExpectation | undefined,
): CheckResult[] {
  if (expect === undefined) {
    return [];
  }
  return [
    ...checkToolsContain(request, expect.toolsContain),
    ...checkToolsAbsent(request, expect.toolsAbsent),
    ...checkCatalog(request, expect.catalogIncludes),
    ...checkCatalogExcludes(request, expect.catalogExcludes),
    ...checkMessages(request, expect.messagesInclude),
    ...checkToolCalls(request, expect.toolCallsInclude),
  ];
}

/**
 * Formats a validation failure for the assistant text the mock returns.
 *
 * @param checks - The failed checks.
 * @returns A multi-line message naming every failure.
 */
export function formatCheckFailures(checks: CheckResult[]): string {
  const lines = checks
    .filter((check) => !check.ok)
    .map((check) => `- ${check.kind} "${check.target}" (${check.detail})`);
  return ['QA mock LLM validation failed:', ...lines].join('\n');
}
