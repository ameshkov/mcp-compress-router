/**
 * Renders Codex CLI event streams as QA transcripts.
 *
 * `codex exec --json` emits one JSON event per line. The runner feeds
 * every line to `handleCodexEventLine`, which prints one `[tool]` entry
 * per completed MCP tool call (arguments plus result or error) and one
 * `[assistant]` entry per agent message. This is the tester-facing
 * transcript; the mock LLM log remains the raw record of what the agent
 * sent to the model.
 */
import { formatValue, printField } from './transcript.js';

/** Minimal shape of one content part in a Codex tool result. */
interface CodexContentPart {
  type?: string;
  text?: string;
}

/** Minimal shape of one Codex event item. */
export interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown } | null;
  error?: { message?: string } | null;
  status?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  message?: string;
}

/** Minimal shape of one Codex event. */
export interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  error?: { message?: string };
  message?: string;
}

/** Mutable transcript state collected during one Codex CLI run. */
export interface CodexTranscriptState {
  sessionID: string;
  toolCalls: number;
}

/**
 * Creates the initial transcript state for a Codex CLI run.
 *
 * @returns The empty state.
 */
export function createCodexTranscriptState(): CodexTranscriptState {
  return { sessionID: '', toolCalls: 0 };
}

/**
 * Extracts the display text of a completed MCP tool call.
 *
 * @param result - The Codex tool result payload.
 * @returns The display text, or undefined when the result is empty.
 */
function resultText(result: CodexItem['result']): unknown {
  const content = result?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const texts = content
      .filter((part: CodexContentPart) => part.type === 'text' && typeof part.text === 'string')
      .map((part: CodexContentPart) => part.text as string);
    if (texts.length === 1) {
      return texts[0];
    }
    return texts.length === 0 ? content : texts.join('\n');
  }
  return content;
}

/**
 * Prints one completed MCP tool call as a transcript entry.
 *
 * @param item - The `mcp_tool_call` item.
 * @param state - The transcript state to update.
 */
function printMcpToolCall(item: CodexItem, state: CodexTranscriptState): void {
  state.toolCalls += 1;
  console.log(`\n[tool] ${item.server ?? 'mcp'}__${item.tool ?? 'unknown'}`);
  printField('  input:  ', formatValue(item.arguments));
  if (item.error !== null && item.error !== undefined) {
    printField('  error:  ', formatValue(item.error.message));
  } else {
    printField('  output: ', formatValue(resultText(item.result)));
  }
}

/**
 * Prints one completed item as a transcript entry.
 *
 * @param item - The event item.
 * @param state - The transcript state to update.
 */
function printItem(item: CodexItem, state: CodexTranscriptState): void {
  if (item.type === 'agent_message' && item.text !== undefined && item.text !== '') {
    console.log(`\n[assistant] ${item.text}`);
    return;
  }
  if (item.type === 'mcp_tool_call') {
    printMcpToolCall(item, state);
    return;
  }
  if (item.type === 'command_execution') {
    state.toolCalls += 1;
    console.log('\n[tool] exec_command');
    printField('  input:  ', formatValue(item.command));
    printField('  output: ', formatValue(item.aggregated_output));
    return;
  }
  if (item.type === 'error' && item.message !== undefined) {
    console.error(`\n[error] ${item.message}`);
  }
}

/**
 * Parses one stdout line and prints its transcript entry.
 *
 * @param line - A raw stdout line from Codex CLI.
 * @param state - The transcript state to update.
 */
export function handleCodexEventLine(line: string, state: CodexTranscriptState): void {
  let event: CodexEvent;
  try {
    event = JSON.parse(line) as CodexEvent;
  } catch {
    return;
  }
  if (event.thread_id !== undefined && event.thread_id !== '') {
    state.sessionID = event.thread_id;
  }
  if (event.type === 'item.completed' && event.item !== undefined) {
    printItem(event.item, state);
    return;
  }
  if (event.type === 'turn.failed' && event.error?.message !== undefined) {
    console.error(`\n[error] ${event.error.message}`);
    return;
  }
  if (event.type === 'error' && event.message !== undefined) {
    console.error(`\n[error] ${event.message}`);
  }
}
