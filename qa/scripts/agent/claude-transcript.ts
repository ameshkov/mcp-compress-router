/**
 * Renders Claude Code event streams as QA transcripts.
 *
 * `claude -p --output-format stream-json --verbose` emits one JSON event
 * per line. The runner feeds every line to `handleClaudeEventLine`,
 * which prints one `[tool]` entry per router tool call (input plus
 * result or error) and one `[assistant]` entry per assistant text
 * block. This is the tester-facing transcript; the mock LLM log remains
 * the raw record of what the agent sent to the model.
 */
import { formatValue, printField } from './transcript.js';

/** Minimal shape of one content block in a Claude Code event. */
export interface ClaudeBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** Minimal shape of one Claude Code event. */
export interface ClaudeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  message?: {
    role?: string;
    content?: ClaudeBlock[];
  };
}

/** Mutable transcript state collected during one Claude Code run. */
export interface ClaudeTranscriptState {
  sessionID: string;
  toolCalls: number;
  /** Inputs of tool calls that started but have not completed yet. */
  pending: Map<string, { name: string; input: unknown }>;
}

/**
 * Creates the initial transcript state for a Claude Code run.
 *
 * @returns The empty state.
 */
export function createClaudeTranscriptState(): ClaudeTranscriptState {
  return { sessionID: '', toolCalls: 0, pending: new Map() };
}

/**
 * Extracts the display text of a completed tool call.
 *
 * @param block - The `tool_result` content block.
 * @returns The display text, or undefined when the result is empty.
 */
function resultText(block: ClaudeBlock): unknown {
  const content = block.content;
  if (typeof content === 'string' || typeof content === 'number') {
    return content;
  }
  if (Array.isArray(content)) {
    const texts = content
      .filter((part: ClaudeBlock) => part.type === 'text' && typeof part.text === 'string')
      .map((part: ClaudeBlock) => part.text as string);
    if (texts.length === 1) {
      return texts[0];
    }
    return texts.length === 0 ? content : texts.join('\n');
  }
  return content;
}

/**
 * Prints one completed tool call as a transcript entry.
 *
 * @param block - The `tool_result` content block.
 * @param state - The transcript state to update.
 */
function printCompletedTool(block: ClaudeBlock, state: ClaudeTranscriptState): void {
  const id = block.tool_use_id ?? '';
  const pending = state.pending.get(id);
  state.pending.delete(id);
  state.toolCalls += 1;
  console.log(`\n[tool] ${pending?.name ?? id}`);
  printField('  input:  ', formatValue(pending?.input));
  if (block.is_error === true) {
    printField('  error:  ', formatValue(resultText(block)));
  } else {
    printField('  output: ', formatValue(resultText(block)));
  }
}

/**
 * Prints the text blocks and records the tool calls of an assistant turn.
 *
 * @param blocks - The assistant content blocks.
 * @param state - The transcript state to update.
 */
function handleAssistantBlocks(blocks: ClaudeBlock[], state: ClaudeTranscriptState): void {
  for (const block of blocks) {
    if (block.type === 'text' && block.text !== undefined && block.text !== '') {
      console.log(`\n[assistant] ${block.text}`);
    }
    if (block.type === 'tool_use') {
      state.pending.set(block.id ?? '', { name: block.name ?? 'unknown', input: block.input });
    }
  }
}

/**
 * Parses one stdout line and prints its transcript entry.
 *
 * @param line - A raw stdout line from Claude Code.
 * @param state - The transcript state to update.
 */
export function handleClaudeEventLine(line: string, state: ClaudeTranscriptState): void {
  let event: ClaudeEvent;
  try {
    event = JSON.parse(line) as ClaudeEvent;
  } catch {
    return;
  }
  if (event.session_id !== undefined && event.session_id !== '') {
    state.sessionID = event.session_id;
  }
  if (event.type === 'assistant') {
    handleAssistantBlocks(event.message?.content ?? [], state);
    return;
  }
  if (event.type === 'user') {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_result') {
        printCompletedTool(block, state);
      }
    }
    return;
  }
  if (event.type === 'result' && event.is_error === true && event.result !== undefined) {
    console.error(`\n[error] ${event.result}`);
  }
}
