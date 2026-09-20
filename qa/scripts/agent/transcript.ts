/**
 * Renders coding-agent event streams as QA transcripts.
 *
 * opencode's `run --format json` emits one JSON event per line. The
 * runner feeds every line to `handleEventLine`, which prints one
 * `[tool]` entry per router tool call (input plus output or error) and
 * one `[assistant]` entry per text part. This is the tester-facing
 * transcript of what the agent did; the mock LLM log is the raw record
 * of what the agent sent to the model.
 */

/** Default maximum length for one rendered transcript value. */
export const MAX_VALUE_LENGTH = 400;

/** Minimal shape of one opencode event from `--format json`. */
export interface OpencodeEvent {
  type?: string;
  sessionID?: string;
  part?: {
    type?: string;
    tool?: string;
    text?: string;
    state?: {
      status?: string;
      input?: unknown;
      output?: unknown;
      error?: string;
    };
  };
}

/** Mutable transcript state collected during one agent run. */
export interface TranscriptState {
  sessionID: string;
  toolCalls: number;
}

/**
 * Renders a value for one transcript line, truncating long text.
 *
 * @param value - The value to render.
 * @param maxLength - Maximum length before truncation.
 * @returns A single-line representation.
 */
export function formatValue(value: unknown, maxLength = MAX_VALUE_LENGTH): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) {
    return '(none)';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}... (${text.length} chars)` : text;
}

/**
 * Prints one labeled transcript field, indenting continuation lines.
 *
 * @param label - The field label, including trailing whitespace.
 * @param value - The field value.
 */
export function printField(label: string, value: string): void {
  const continuation = ' '.repeat(label.length);
  console.log(`${label}${value.replaceAll('\n', `\n${continuation}`)}`);
}

/**
 * Prints one event as a transcript entry.
 *
 * @param event - The parsed opencode event.
 * @returns True when the event was a tool call.
 */
function printEvent(event: OpencodeEvent): boolean {
  const part = event.part;
  if (event.type === 'text' && part?.text !== undefined) {
    console.log(`\n[assistant] ${part.text}`);
    return false;
  }
  if (event.type !== 'tool_use' || part?.tool === undefined) {
    return false;
  }
  const toolState = part.state ?? {};
  console.log(`\n[tool] ${part.tool}`);
  printField('  input:  ', formatValue(toolState.input));
  if (toolState.status === 'error') {
    printField('  error:  ', formatValue(toolState.error));
  } else {
    printField('  output: ', formatValue(toolState.output));
  }
  return true;
}

/**
 * Parses one stdout line and prints its transcript entry.
 *
 * @param line - A raw stdout line from opencode.
 * @param state - The transcript state to update.
 */
export function handleEventLine(line: string, state: TranscriptState): void {
  let event: OpencodeEvent;
  try {
    event = JSON.parse(line) as OpencodeEvent;
  } catch {
    return;
  }
  if (event.sessionID !== undefined && event.sessionID !== '') {
    state.sessionID = event.sessionID;
  }
  if (printEvent(event)) {
    state.toolCalls += 1;
  }
}
