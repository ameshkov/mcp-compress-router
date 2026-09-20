/**
 * Admin API client and log renderer for the QA mock LLM.
 *
 * Shared by `pnpm qa:llm` (the tester's control and inspection tool)
 * and `pnpm qa:agent` (which checks the validation results after a
 * coding-agent session).
 */
import type { LlmLogEntry } from './log.js';

/** One built-in script as listed by the admin API. */
export interface LlmScriptSummary {
  name: string;
  description: string;
  steps: number;
}

/** Current mock state reported by `/admin/status` and `/health`. */
export interface LlmStatus {
  ok: boolean;
  script: string | null;
  stepIndex: number;
  steps: number;
  requestCount: number;
}

/** The full request/response log reported by `/admin/log`. */
export interface LlmLog extends LlmStatus {
  requests: LlmLogEntry[];
}

/** An inline script payload accepted by `/admin/script`. */
export interface InlineScript {
  name?: string;
  description?: string;
  steps: unknown[];
}

/** Wire shape of the tool definitions inside a logged request. */
interface LoggedTool {
  name?: string;
  type?: string;
  function?: { name?: string; description?: string };
  tools?: LoggedTool[];
}

/** Wire shape of one Responses output item inside a logged response. */
interface LoggedResponsesItem {
  type?: string;
  name?: string;
  namespace?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
}

/** Wire shape of an assistant message inside a logged response. */
interface LoggedAssistantMessage {
  content?: string | null;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

/** Wire shape of one Anthropic response content block. */
interface LoggedAnthropicBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

/**
 * Returns the mock LLM base URL.
 *
 * The Compose workspace sets `QA_LLM_URL` to the in-network address, so
 * a missing variable means the command is running outside the workspace
 * (a host checkout would otherwise silently use host artifacts).
 *
 * @returns `QA_LLM_URL` without a trailing slash.
 * @throws When `QA_LLM_URL` is not set.
 */
export function llmBaseUrl(): string {
  const raw = process.env.QA_LLM_URL;
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      'QA_LLM_URL is not set. Run the QA commands inside the workspace container ' +
        '(see qa/README.md): docker compose -f qa/docker-compose.yml exec workspace <command>.',
    );
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Calls one admin endpoint and parses its JSON response.
 *
 * @param path - The endpoint path.
 * @param init - Optional fetch options.
 * @returns The parsed response body.
 * @throws When the request fails or the response is not JSON.
 */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${llmBaseUrl()}${path}`, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `mock LLM ${init?.method ?? 'GET'} ${path} failed (${response.status}): ${text}`,
    );
  }
  return JSON.parse(text) as T;
}

/**
 * Fetches the built-in scripts.
 *
 * @returns The script summaries.
 */
export async function fetchScripts(): Promise<LlmScriptSummary[]> {
  const payload = await requestJson<{ scripts: LlmScriptSummary[] }>('/admin/scripts');
  return payload.scripts;
}

/**
 * Fetches the current mock state.
 *
 * @returns The status payload.
 */
export function fetchStatus(): Promise<LlmStatus> {
  return requestJson<LlmStatus>('/admin/status');
}

/**
 * Fetches the full request/response log.
 *
 * @returns The log payload.
 */
export function fetchLog(): Promise<LlmLog> {
  return requestJson<LlmLog>('/admin/log');
}

/**
 * Selects a built-in script and resets the mock.
 *
 * @param name - The built-in script name.
 * @returns The selected script summary.
 */
export function selectScript(name: string): Promise<{ script: LlmScriptSummary }> {
  return requestJson<{ script: LlmScriptSummary }>('/admin/script', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

/**
 * Installs an inline script and resets the mock.
 *
 * @param script - The inline script payload.
 * @returns The installed script summary.
 */
export function installInlineScript(script: InlineScript): Promise<{ script: LlmScriptSummary }> {
  return requestJson<{ script: LlmScriptSummary }>('/admin/script', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(script),
  });
}

/**
 * Resets the mock step and clears its log.
 */
export async function resetLlm(): Promise<void> {
  await requestJson<{ ok: boolean }>('/admin/reset', { method: 'POST' });
}

/**
 * Counts the failed validation checks in a log.
 *
 * @param log - The log payload.
 * @returns The number of failed checks.
 */
export function countFailedChecks(log: LlmLog): number {
  return log.requests.reduce(
    (total, entry) => total + entry.checks.filter((check) => !check.ok).length,
    0,
  );
}

/**
 * Counts the passed validation checks in a log.
 *
 * @param log - The log payload.
 * @returns The number of passed checks.
 */
export function countPassedChecks(log: LlmLog): number {
  return log.requests.reduce(
    (total, entry) => total + entry.checks.filter((check) => check.ok).length,
    0,
  );
}

/**
 * Flattens one logged tool into its wire-visible names.
 *
 * Codex CLI nests MCP tools inside namespace tools, so the namespace
 * children are listed with their qualified `<namespace>__<name>` names
 * and the namespace container itself is not listed.
 *
 * @param tool - The logged tool.
 * @returns The tool names, qualified for namespaced tools.
 */
function loggedToolNamesOf(tool: LoggedTool): string[] {
  if (tool.type === 'namespace') {
    const namespace = tool.name ?? '';
    return (tool.tools ?? []).flatMap((child) =>
      loggedToolNamesOf(child).map((name) => `${namespace}__${name}`),
    );
  }
  const name = tool.function?.name ?? tool.name ?? '';
  return name === '' ? [] : [name];
}

/**
 * Extracts the advertised tool names from a logged request.
 *
 * @param entry - The log entry.
 * @returns The tool names in request order.
 */
function loggedToolNames(entry: LlmLogEntry): string[] {
  const request = entry.request as { tools?: LoggedTool[] } | null;
  return (request?.tools ?? []).flatMap(loggedToolNamesOf);
}

/**
 * Renders the assistant turn of an Anthropic response.
 *
 * @param blocks - The response content blocks.
 * @returns A one-line response summary.
 */
function renderAnthropicResponse(blocks: LoggedAnthropicBlock[]): string {
  const call = blocks.find((block) => block.type === 'tool_use');
  if (call !== undefined) {
    return `tool ${call.name ?? '?'} ${JSON.stringify(call.input ?? {})}`;
  }
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
  return `text ${JSON.stringify(text)}`;
}

/**
 * Renders the assistant turn of a Responses response.
 *
 * @param output - The response output items.
 * @returns A one-line response summary.
 */
function renderResponsesResponse(output: LoggedResponsesItem[]): string {
  const call = output.find((item) => item.type === 'function_call');
  if (call !== undefined) {
    const name = call.namespace === undefined ? call.name : `${call.namespace}__${call.name}`;
    return `tool ${name ?? '?'} ${call.arguments ?? ''}`;
  }
  const text = output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('\n');
  return `text ${JSON.stringify(text)}`;
}

/**
 * Renders the assistant turn of a logged response.
 *
 * @param entry - The log entry.
 * @returns A one-line response summary.
 */
function renderResponse(entry: LlmLogEntry): string {
  const body = entry.response.body as {
    choices?: Array<{ message?: LoggedAssistantMessage }>;
    content?: LoggedAnthropicBlock[];
    output?: LoggedResponsesItem[];
  } | null;
  const message = body?.choices?.[0]?.message;
  if (message !== undefined) {
    const call = message.tool_calls?.[0];
    if (call !== undefined) {
      return `tool ${call.function?.name ?? '?'} ${call.function?.arguments ?? ''}`;
    }
    return `text ${JSON.stringify(message.content ?? '')}`;
  }
  if (Array.isArray(body?.output)) {
    return renderResponsesResponse(body.output);
  }
  return renderAnthropicResponse(body?.content ?? []);
}

/**
 * Renders one log entry as readable lines.
 *
 * @param entry - The log entry.
 * @param steps - Total number of steps in the selected script.
 * @returns The rendered lines.
 */
function renderEntry(entry: LlmLogEntry, steps: number): string[] {
  const step = entry.stepIndex === null ? '' : ` step ${entry.stepIndex + 1}/${steps}`;
  const kind = entry.auxiliary ? ' auxiliary' : ' main';
  const lines = [`[request ${entry.index}]${kind}${step}`];
  const tools = loggedToolNames(entry);
  if (tools.length > 0) {
    lines.push(`  tools (${tools.length}): ${tools.join(', ')}`);
  }
  for (const check of entry.checks) {
    const detail = check.ok ? '' : ` -- ${check.detail}`;
    lines.push(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.kind}: ${check.target}${detail}`);
  }
  lines.push(`  response (${entry.response.kind}): ${renderResponse(entry)}`);
  return lines;
}

/**
 * Renders a human-readable summary of the log.
 *
 * @param log - The log payload.
 * @returns The rendered summary.
 */
export function renderLogSummary(log: LlmLog): string {
  const main = log.requests.filter((entry) => !entry.auxiliary).length;
  const auxiliary = log.requests.length - main;
  const lines = [
    `Script: ${log.script ?? '(none selected)'} (${log.stepIndex}/${log.steps} steps served)`,
    `Requests: ${log.requests.length} (${main} with tools, ${auxiliary} auxiliary)`,
    '',
  ];
  for (const entry of log.requests) {
    lines.push(...renderEntry(entry, log.steps), '');
  }
  const passed = countPassedChecks(log);
  const failed = countFailedChecks(log);
  lines.push(`Checks: ${passed} passed, ${failed} failed`);
  return lines.join('\n');
}

/**
 * Renders a compact validation report for `pnpm qa:agent`.
 *
 * @param log - The log payload.
 * @returns The validation summary, with one line per failed check.
 */
export function renderValidationSummary(log: LlmLog): string {
  const main = log.requests.filter((entry) => !entry.auxiliary).length;
  const auxiliary = log.requests.length - main;
  const lines = [
    `Script: ${log.script ?? '(none selected)'} (${log.stepIndex}/${log.steps} steps served)`,
    `Requests: ${log.requests.length} (${main} with tools, ${auxiliary} auxiliary)`,
    `Checks: ${countPassedChecks(log)} passed, ${countFailedChecks(log)} failed`,
  ];
  for (const entry of log.requests) {
    for (const check of entry.checks) {
      if (!check.ok) {
        lines.push(
          `  FAIL [request ${entry.index}] ${check.kind}: ${check.target} -- ${check.detail}`,
        );
      }
    }
  }
  return lines.join('\n');
}

/**
 * Renders the complete raw log as pretty JSON.
 *
 * @param log - The log payload.
 * @returns The raw JSON text.
 */
export function renderRawLog(log: LlmLog): string {
  return JSON.stringify(log, null, 2);
}
