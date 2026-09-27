/**
 * Transcript handlers for the benchmark agent event streams.
 *
 * All four agents can emit one JSON event per line; the handlers print
 * a compact `[tool]` / `[assistant]` transcript while counting the
 * agent's LLM turns ("steps"). The token metrics come from ccusage, not
 * from these events.
 *
 * A step is one request/response round-trip with the model, not one tool
 * call: a turn may call several tools or none. Claude Code and Copilot
 * CLI expose it as a unique assistant message id, OpenCode as a
 * `step_finish` event. The Codex stream has no per-turn event, so its
 * step count is derived from completed reasoning and answer items.
 */

/** Default maximum length for one rendered transcript value. */
const MAX_VALUE_LENGTH = 300;

/** Mutable transcript state collected during one agent run. */
export interface TranscriptState {
  /** Session id reported by the agent, when it reports one. */
  sessionID: string;
  /** Number of LLM turns observed in the event stream. */
  steps: number;
  /** Assistant message ids already counted as steps (Claude Code, Copilot CLI). */
  countedMessages: Set<string>;
}

/**
 * Creates the initial transcript state for one run.
 *
 * @returns The empty state.
 */
export function createTranscriptState(): TranscriptState {
  return { sessionID: '', steps: 0, countedMessages: new Set() };
}

/**
 * Renders a value for one transcript line, truncating long text.
 *
 * @param value - The value to render.
 * @returns A single-line representation.
 */
export function formatValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) {
    return '(none)';
  }
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}...` : text;
}

/**
 * Parses a JSON line, returning undefined for non-JSON output.
 *
 * @param line - A raw stdout line.
 * @returns The parsed record, or undefined.
 */
function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a nested record property.
 *
 * @param record - The parent record.
 * @param key - The property name.
 * @returns The nested record, or undefined.
 */
function recordAt(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads a nested string property.
 *
 * @param record - The parent record.
 * @param key - The property name.
 * @returns The string value, or undefined.
 */
function stringAt(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Handles one Claude Code `stream-json` line.
 *
 * @param line - A raw stdout line.
 * @param state - The transcript state to update.
 */
export function handleClaudeLine(line: string, state: TranscriptState): void {
  const event = parseLine(line);
  if (event === undefined) {
    return;
  }
  const sessionID = stringAt(event, 'session_id');
  if (sessionID !== undefined && sessionID !== '') {
    state.sessionID = sessionID;
  }
  if (event.type !== 'assistant') {
    return;
  }
  const message = recordAt(event, 'message');
  if (message === undefined) {
    return;
  }
  const messageID = stringAt(message, 'id');
  if (messageID !== undefined && messageID !== '' && !state.countedMessages.has(messageID)) {
    state.countedMessages.add(messageID);
    state.steps += 1;
  }
  const blocks = message.content;
  if (!Array.isArray(blocks)) {
    return;
  }
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) {
      continue;
    }
    const content = block as Record<string, unknown>;
    if (content.type === 'text' && typeof content.text === 'string' && content.text !== '') {
      console.log(`\n[assistant] ${content.text}`);
    }
    if (content.type === 'tool_use') {
      console.log(`\n[tool] ${stringAt(content, 'name') ?? 'unknown'}`);
    }
  }
}

/**
 * Handles one Codex `exec --json` line.
 *
 * @param line - A raw stdout line.
 * @param state - The transcript state to update.
 */
export function handleCodexLine(line: string, state: TranscriptState): void {
  const event = parseLine(line);
  if (event === undefined) {
    return;
  }
  const threadID = stringAt(event, 'thread_id');
  if (threadID !== undefined && threadID !== '') {
    state.sessionID = threadID;
  }
  if (event.type !== 'item.completed') {
    return;
  }
  const item = recordAt(event, 'item');
  if (item === undefined) {
    return;
  }
  if (item.type === 'agent_message') {
    state.steps += 1;
    if (typeof item.text === 'string' && item.text !== '') {
      console.log(`\n[assistant] ${item.text}`);
    }
    return;
  }
  if (item.type === 'reasoning') {
    state.steps += 1;
    return;
  }
  if (item.type === 'mcp_tool_call') {
    console.log(
      `\n[tool] ${stringAt(item, 'server') ?? 'mcp'}__${stringAt(item, 'tool') ?? 'unknown'}`,
    );
    return;
  }
  if (item.type === 'command_execution') {
    console.log(`\n[tool] exec_command: ${formatValue(item.command)}`);
  }
}

/**
 * Handles one OpenCode `run --format json` line.
 *
 * @param line - A raw stdout line.
 * @param state - The transcript state to update.
 */
export function handleOpencodeLine(line: string, state: TranscriptState): void {
  const event = parseLine(line);
  if (event === undefined) {
    return;
  }
  const sessionID = stringAt(event, 'sessionID');
  if (sessionID !== undefined && sessionID !== '') {
    state.sessionID = sessionID;
  }
  if (event.type === 'step_finish') {
    state.steps += 1;
  }
  const part = recordAt(event, 'part');
  if (part === undefined) {
    return;
  }
  if (event.type === 'text' && typeof part.text === 'string' && part.text !== '') {
    console.log(`\n[assistant] ${part.text}`);
    return;
  }
  if (event.type === 'tool_use' && typeof part.tool === 'string') {
    console.log(`\n[tool] ${part.tool}`);
  }
}

/**
 * Handles one Copilot CLI `--output-format json` line.
 *
 * @param line - A raw stdout line.
 * @param state - The transcript state to update.
 */
export function handleCopilotLine(line: string, state: TranscriptState): void {
  const event = parseLine(line);
  if (event === undefined) {
    return;
  }
  if (event.type === 'result') {
    const data = recordAt(event, 'data');
    const sessionID = stringAt(event, 'sessionId') ?? (data && stringAt(data, 'sessionId'));
    if (sessionID !== undefined && sessionID !== '') {
      state.sessionID = sessionID;
    }
    return;
  }
  const data = recordAt(event, 'data');
  if (data === undefined) {
    return;
  }
  if (event.type === 'assistant.message') {
    const messageID = stringAt(data, 'messageId');
    if (messageID !== undefined && messageID !== '' && !state.countedMessages.has(messageID)) {
      state.countedMessages.add(messageID);
      state.steps += 1;
    }
    const content = stringAt(data, 'content');
    if (content !== undefined && content !== '') {
      console.log(`\n[assistant] ${content}`);
    }
    return;
  }
  if (event.type === 'tool.execution_start') {
    const name = stringAt(data, 'toolName');
    if (name !== undefined && name !== '') {
      console.log(`\n[tool] ${name}`);
    }
  }
}
