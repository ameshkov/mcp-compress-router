/**
 * Shared types for the coding-agent runners in the manual QA stack.
 *
 * Every agent runner (`opencode.ts`, `copilot.ts`, `claude.ts`,
 * `codex.ts`) accepts the same session and listing options and reports
 * the same outcome shape, so `pnpm qa:agent` can dispatch on `--agent`
 * without agent-specific handling.
 */

/** Coding agents the QA driver can run. */
export type AgentName = 'opencode' | 'copilot' | 'claude' | 'codex';

/** Options for a session driven by a real model instead of the mock LLM. */
export interface RealLlmOptions {
  /**
   * Model reference in `<provider>/<model>` form, e.g.
   * `openrouter/~deepseek/deepseek-flash-latest`. Only the OpenRouter
   * provider is supported by the real-LLM plans.
   */
  model: string;
}

/** Options for one scripted agent session. */
export interface AgentRunOptions {
  /** Prompt to pass to the agent. */
  prompt: string;
  /**
   * Mock LLM base URL (without `/v1`). Unused when {@link realLlm} is
   * set — the runner then talks to the real provider instead.
   */
  llmUrl: string;
  /** How long to wait before killing the agent. */
  timeoutMs: number;
  /** Optional path for the raw JSON event stream. */
  eventsPath?: string;
  /** Keep the scratch config home for debugging. */
  keep: boolean;
  /** When set, run against the real provider instead of the mock LLM. */
  realLlm?: RealLlmOptions;
}

/** Minimal transcript state every agent runner reports. */
export interface AgentTranscriptState {
  /** Agent session id, or an empty string. */
  sessionID: string;
  /** Number of tool calls observed in the transcript. */
  toolCalls: number;
}

/** Outcome of one scripted agent session. */
export interface AgentRunResult {
  /** Agent exit code (1 on timeout or spawn failure). */
  exitCode: number;
  /** True when the agent had to be killed after the timeout. */
  timedOut: boolean;
  /** Number of tool calls observed in the transcript. */
  toolCalls: number;
  /** Agent session id, or an empty string. */
  sessionID: string;
}

/** Options for the agent's MCP listing command. */
export interface AgentListOptions {
  /** Mock LLM base URL; not contacted in this mode. */
  llmUrl: string;
  /** How long to wait before killing the agent. */
  timeoutMs: number;
  /** Keep the scratch config home for debugging. */
  keep: boolean;
  /** When set, use the real-provider config instead of the mock LLM config. */
  realLlm?: RealLlmOptions;
}

/** The default agent timeout in milliseconds. */
export const AGENT_DEFAULT_TIMEOUT_MS = 60_000;
