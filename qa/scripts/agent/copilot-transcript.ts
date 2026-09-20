/**
 * Renders Copilot CLI event streams as QA transcripts.
 *
 * `copilot -p --output-format json` emits one JSON event per line. The
 * runner feeds every line to `handleCopilotEventLine`, which prints one
 * `[tool]` entry per router tool call (input plus result or error) and
 * one `[assistant]` entry per complete assistant message. This is the
 * tester-facing transcript; the mock LLM log remains the raw record of
 * what the agent sent to the model.
 */
import { formatValue, printField } from './transcript.js';

/** Minimal shape of one Copilot CLI event. */
export interface CopilotEvent {
  type?: string;
  sessionId?: string;
  data?: {
    toolCallId?: string;
    toolName?: string;
    arguments?: unknown;
    success?: boolean;
    error?: unknown;
    result?: { content?: unknown; contents?: Array<{ text?: string }> };
    content?: string;
    message?: string;
    sessionId?: string;
  };
}

/** Mutable transcript state collected during one Copilot CLI run. */
export interface CopilotTranscriptState {
  sessionID: string;
  toolCalls: number;
  /** Inputs of tool calls that started but have not completed yet. */
  pending: Map<string, { name: string; input: unknown }>;
}

/**
 * Creates the initial transcript state for a Copilot CLI run.
 *
 * @returns The empty state.
 */
export function createCopilotTranscriptState(): CopilotTranscriptState {
  return { sessionID: '', toolCalls: 0, pending: new Map() };
}

/**
 * Renders the result text of a completed tool call.
 *
 * @param event - The parsed `tool.execution_complete` event.
 * @returns The display text, or undefined when the result is empty.
 */
function resultText(event: CopilotEvent): unknown {
  const result = event.data?.result;
  if (result === undefined) {
    return undefined;
  }
  if (typeof result.content === 'string' || typeof result.content === 'number') {
    return result.content;
  }
  return result.contents?.[0]?.text ?? result;
}

/**
 * Prints one completed tool call as a transcript entry.
 *
 * @param event - The parsed `tool.execution_complete` event.
 * @param state - The transcript state to update.
 */
function printCompletedTool(event: CopilotEvent, state: CopilotTranscriptState): void {
  const id = event.data?.toolCallId ?? '';
  const pending = state.pending.get(id);
  const name = event.data?.toolName ?? pending?.name ?? 'unknown';
  const input = pending?.input ?? event.data?.arguments;
  state.pending.delete(id);
  state.toolCalls += 1;
  console.log(`\n[tool] ${name}`);
  printField('  input:  ', formatValue(input));
  if (event.data?.success === false) {
    printField('  error:  ', formatValue(event.data.error ?? resultText(event)));
  } else {
    printField('  output: ', formatValue(resultText(event)));
  }
}

/**
 * Parses one stdout line and prints its transcript entry.
 *
 * @param line - A raw stdout line from Copilot CLI.
 * @param state - The transcript state to update.
 */
export function handleCopilotEventLine(line: string, state: CopilotTranscriptState): void {
  let event: CopilotEvent;
  try {
    event = JSON.parse(line) as CopilotEvent;
  } catch {
    return;
  }
  const data = event.data;
  if (event.type === 'tool.execution_start' && data !== undefined) {
    state.pending.set(data.toolCallId ?? '', {
      name: data.toolName ?? 'unknown',
      input: data.arguments,
    });
    return;
  }
  if (event.type === 'tool.execution_complete') {
    printCompletedTool(event, state);
    return;
  }
  if (event.type === 'assistant.message' && data?.content !== undefined && data.content !== '') {
    console.log(`\n[assistant] ${data.content}`);
    return;
  }
  if (event.type === 'session.error' && data?.message !== undefined) {
    console.error(`\n[error] ${data.message}`);
    return;
  }
  if (event.type === 'result') {
    const sessionID = event.sessionId ?? data?.sessionId;
    if (sessionID !== undefined && sessionID !== '') {
      state.sessionID = sessionID;
    }
  }
}
