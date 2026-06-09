import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from './logger.js';

function captureStderr(): { output: string; restore: () => void } {
  let output = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((
    ...args: Parameters<typeof process.stderr.write>
  ) => {
    const chunk = args[0];
    if (typeof chunk === 'string') {
      output += chunk;
    } else if (chunk instanceof Buffer) {
      output += chunk.toString();
    } else if (chunk instanceof Uint8Array) {
      output += new TextDecoder().decode(chunk);
    }
    return true;
  }) as typeof process.stderr.write);
  return {
    get output() {
      return output;
    },
    restore: () => spy.mockRestore(),
  };
}

describe('Logger', () => {
  let capture: ReturnType<typeof captureStderr>;

  beforeEach(() => {
    capture = captureStderr();
  });

  afterEach(() => {
    capture.restore();
  });

  function parseLines(): Array<{
    timestamp: string;
    level: string;
    message: string;
    context?: Record<string, unknown>;
  }> {
    return capture.output
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
  }

  it('emits error at default info level', () => {
    const logger = new Logger('info');
    logger.error('something broke', { server: 'test' });
    const lines = parseLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('error');
    expect(lines[0].message).toBe('something broke');
    expect(lines[0].context).toEqual({ server: 'test' });
    expect(lines[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('emits info at default info level', () => {
    const logger = new Logger('info');
    logger.info('server connected');
    const lines = parseLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('info');
    expect(lines[0].message).toBe('server connected');
  });

  it('suppresses debug at default info level', () => {
    const logger = new Logger('info');
    logger.debug('payload details', { payload: 'secret' });
    expect(capture.output.trim()).toBe('');
  });

  it('emits debug at verbose (debug) level', () => {
    const logger = new Logger('debug');
    logger.debug('payload details', { payload: 'secret' });
    const lines = parseLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('debug');
    expect(lines[0].context).toEqual({ payload: 'secret' });
  });

  it('suppresses info at error level', () => {
    const logger = new Logger('error');
    logger.info('server connected');
    expect(capture.output.trim()).toBe('');
  });

  it('still emits error at error level', () => {
    const logger = new Logger('error');
    logger.error('fatal');
    const lines = parseLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('error');
  });

  it('omits context key when context is empty', () => {
    const logger = new Logger('info');
    logger.info('no context', {});
    const lines = parseLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].context).toBeUndefined();
  });

  it('omits context key when context is not provided', () => {
    const logger = new Logger('info');
    logger.info('no context at all');
    const lines = parseLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].context).toBeUndefined();
  });

  it('setLevel changes the effective level', () => {
    const logger = new Logger('error');
    logger.info('should be suppressed');
    logger.setLevel('info');
    logger.info('should appear');
    const lines = parseLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe('should appear');
  });

  it('isLevelEnabled returns correct values', () => {
    const logger = new Logger('info');
    expect(logger.isLevelEnabled('error')).toBe(true);
    expect(logger.isLevelEnabled('info')).toBe(true);
    expect(logger.isLevelEnabled('debug')).toBe(false);
  });
});
