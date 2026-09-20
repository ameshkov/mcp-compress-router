/**
 * Wire-protocol adapters for the QA mock LLM.
 *
 * The mock speaks three protocols: the OpenAI chat completions API used
 * by opencode and GitHub Copilot CLI, the Anthropic Messages API used by
 * Claude Code, and the OpenAI Responses API used by Codex CLI.
 * Everything downstream of parsing (script selection, expectation
 * checks, tool-name resolution) works on the shared `WireChatRequest`
 * shape, so an adapter only has to normalize its request and render the
 * scripted assistant turn back in its own wire format.
 */
import type { ServerResponse } from 'node:http';
import type { Completion } from './completions.js';
import type { ScriptStep } from './scripts.js';
import type { WireChatRequest } from './tool-names.js';

/** One parsed request normalized to the shape the checks inspect. */
export interface NormalizedRequest {
  /** The request in the shared, OpenAI-compatible shape. */
  request: WireChatRequest;
  /** True when the client asked for an SSE stream. */
  stream: boolean;
}

/** Maps one wire protocol onto the mock's scripted serving pipeline. */
export interface ProtocolAdapter {
  /** Protocol name used in comments and debug output. */
  name: 'openai' | 'anthropic' | 'responses';
  /**
   * Parses a raw request body into the shared request shape.
   *
   * @param body - The parsed JSON request body.
   * @returns The normalized request and stream flag.
   */
  normalize(body: unknown): NormalizedRequest;
  /**
   * Builds a plain text turn in the protocol's wire format.
   *
   * @param text - The assistant text.
   * @param model - The model id to report.
   * @returns The completion.
   */
  buildText(text: string, model: string): Completion;
  /**
   * Builds a tool-call turn in the protocol's wire format.
   *
   * @param step - The resolved script step to serve.
   * @param model - The model id to report.
   * @param callId - The tool call id.
   * @returns The completion.
   */
  buildStep(step: ScriptStep, model: string, callId: string): Completion;
  /**
   * Writes one completion in the protocol's wire format.
   *
   * @param res - The server response.
   * @param completion - The completion to write.
   * @param stream - True for SSE, false for plain JSON.
   */
  write(res: ServerResponse, completion: Completion, stream: boolean): void;
}
