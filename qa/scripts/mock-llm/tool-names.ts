/**
 * Wire-shape helpers for the QA mock LLM.
 *
 * The mock inspects OpenAI-compatible request bodies and matches the
 * tool names the agent advertised. Agents prefix MCP tool names
 * differently (`qa-router_get_tool_schema` for opencode,
 * `qa-router-get_tool_schema` for Copilot CLI,
 * `mcp__qa-router__get_tool_schema` for Claude Code, and a
 * `mcp__qa_router` namespace tool for Codex CLI), so every comparison
 * normalizes the separator first, and scripted tool calls are rewritten
 * to the exact wire name the agent knows.
 */
import type { ScriptStep } from './scripts.js';

/** Wire shape of one tool definition in an OpenAI-compatible request. */
export interface WireTool {
  function?: { name?: string; description?: string; parameters?: unknown };
  /**
   * Namespace the function is nested in. Codex CLI's Responses API
   * advertises MCP tools inside a namespace tool
   * (`{"type":"namespace","name":"mcp__qa_router","tools":[...]}`), and
   * the namespace is part of the tool's wire identity: a function call
   * must carry it or the agent cannot dispatch the call.
   */
  namespace?: string;
}

/** Wire shape of one tool call inside an assistant message. */
export interface WireToolCall {
  function?: { name?: string; arguments?: unknown };
}

/** Wire shape of one message in an OpenAI-compatible request. */
export interface WireMessage {
  role?: string;
  content?: unknown;
  tool_calls?: WireToolCall[];
}

/** The request fields the mock inspects. */
export interface WireChatRequest {
  stream?: boolean;
  tools?: WireTool[];
  messages?: WireMessage[];
}

/**
 * Normalizes every non-alphanumeric separator to `_`.
 *
 * @param name - The tool name.
 * @returns The name with separators normalized.
 */
function normalizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '_');
}

/**
 * Matches an actual tool name against an expected one.
 *
 * @param actual - The name the agent advertised or called.
 * @param expected - The expected name.
 * @returns True on an exact match or a suffix match after a separator.
 */
export function matchesName(actual: string, expected: string): boolean {
  const normalizedActual = normalizeName(actual);
  const normalizedExpected = normalizeName(expected);
  if (normalizedActual === normalizedExpected) {
    return true;
  }
  if (!normalizedActual.endsWith(normalizedExpected)) {
    return false;
  }
  return normalizedActual[normalizedActual.length - normalizedExpected.length - 1] === '_';
}

/**
 * Returns the wire-visible name of one advertised tool.
 *
 * Tools nested in a namespace (Codex CLI's Responses API) are qualified
 * as `<namespace>__<name>` so the existing suffix matching works
 * unchanged.
 *
 * @param tool - The advertised tool.
 * @returns The name, qualified with the namespace when there is one.
 */
export function wireToolName(tool: WireTool): string {
  const name = tool.function?.name ?? '';
  if (name === '' || tool.namespace === undefined || tool.namespace === '') {
    return name;
  }
  return `${tool.namespace}__${name}`;
}

/**
 * Returns the tool names in the request.
 *
 * @param request - The parsed model request.
 * @returns The advertised tool names, namespaced ones qualified.
 */
export function toolNames(request: WireChatRequest): string[] {
  return (request.tools ?? []).map(wireToolName).filter((name) => name !== '');
}

/**
 * Finds the advertised tool that matches an expected name.
 *
 * @param request - The parsed model request.
 * @param expected - The expected name.
 * @returns The matching tool, or undefined when none matches.
 */
export function resolveWireTool(request: WireChatRequest, expected: string): WireTool | undefined {
  return (request.tools ?? []).find((tool) => matchesName(wireToolName(tool), expected));
}

/**
 * Resolves a scripted tool name to the name the agent advertised.
 *
 * Agents prefix MCP tool names differently, but the scripted tool call
 * has to use the exact wire name the agent knows, or the agent rejects
 * the call. This maps the script's generic name onto the matching
 * advertised name.
 *
 * @param request - The parsed model request.
 * @param scripted - The tool name written in the script.
 * @returns The advertised name, or the scripted name when none matches.
 */
export function resolveScriptedToolName(request: WireChatRequest, scripted: string): string {
  const tool = resolveWireTool(request, scripted);
  return tool === undefined ? scripted : wireToolName(tool);
}

/**
 * Rewrites a scripted tool step to the wire target the agent advertised.
 *
 * The resolved call keeps the agent's exact function name and, when the
 * advertised tool lives in a namespace, its namespace, so the Responses
 * adapter can render a dispatchable function call.
 *
 * @param step - The script step to serve.
 * @param request - The parsed model request.
 * @returns The step, with the tool target resolved when it is a tool turn.
 */
export function resolveToolStep(step: ScriptStep, request: WireChatRequest): ScriptStep {
  if (!('tool' in step.respond)) {
    return step;
  }
  const tool = resolveWireTool(request, step.respond.tool.name);
  if (tool === undefined) {
    return step;
  }
  const resolved = {
    ...step.respond.tool,
    name: tool.function?.name ?? step.respond.tool.name,
  };
  if (tool.namespace !== undefined && tool.namespace !== '') {
    resolved.namespace = tool.namespace;
  }
  return { ...step, respond: { tool: resolved } };
}
