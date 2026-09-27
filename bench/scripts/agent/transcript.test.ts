import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTranscriptState,
  handleClaudeLine,
  handleCodexLine,
  handleCopilotLine,
  handleOpencodeLine,
} from './transcript.js';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('Claude Code transcript steps', () => {
  it('counts unique assistant message ids as steps', () => {
    const state = createTranscriptState();
    const assistant = (id: string, text: string): string =>
      JSON.stringify({
        type: 'assistant',
        session_id: 'session',
        message: { id, content: [{ type: 'text', text }] },
      });
    handleClaudeLine(assistant('msg_1', 'first'), state);
    handleClaudeLine(assistant('msg_1', 'first'), state);
    handleClaudeLine(assistant('msg_2', 'second'), state);
    handleClaudeLine(
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
      state,
    );
    expect(state.steps).toBe(2);
    expect(state.sessionID).toBe('session');
  });
});

describe('Codex transcript steps', () => {
  it('counts completed reasoning and answer items as steps', () => {
    const state = createTranscriptState();
    const item = (type: string): string =>
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type } });
    handleCodexLine(JSON.stringify({ type: 'thread.started', thread_id: 'thread' }), state);
    handleCodexLine(item('reasoning'), state);
    handleCodexLine(item('command_execution'), state);
    handleCodexLine(item('agent_message'), state);
    expect(state.steps).toBe(2);
    expect(state.sessionID).toBe('thread');
  });
});

describe('OpenCode transcript steps', () => {
  it('counts step_finish events as steps', () => {
    const state = createTranscriptState();
    const event = (type: string, part: Record<string, unknown>): string =>
      JSON.stringify({ type, sessionID: 'ses_1', part });
    handleOpencodeLine(event('step_start', { type: 'step-start' }), state);
    handleOpencodeLine(event('tool_use', { tool: 'bash' }), state);
    handleOpencodeLine(event('step_finish', { type: 'step-finish' }), state);
    handleOpencodeLine(event('step_finish', { type: 'step-finish' }), state);
    expect(state.steps).toBe(2);
    expect(state.sessionID).toBe('ses_1');
  });
});

describe('Copilot CLI transcript steps', () => {
  it('counts unique assistant message ids as steps', () => {
    const state = createTranscriptState();
    const message = (messageId: string, content: string): string =>
      JSON.stringify({ type: 'assistant.message', data: { messageId, content } });
    handleCopilotLine(
      JSON.stringify({ type: 'tool.execution_start', data: { toolName: 'bash' } }),
      state,
    );
    handleCopilotLine(message('m1', 'first'), state);
    handleCopilotLine(message('m1', 'first'), state);
    handleCopilotLine(message('m2', 'second'), state);
    handleCopilotLine(JSON.stringify({ type: 'result', sessionId: 'session', data: {} }), state);
    expect(state.steps).toBe(2);
    expect(state.sessionID).toBe('session');
  });
});
