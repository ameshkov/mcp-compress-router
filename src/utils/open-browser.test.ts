import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { openBrowser } from './open-browser.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

describe('openBrowser', () => {
  const originalPlatform = process.platform;
  let mockChild: ChildProcess;

  beforeEach(() => {
    mockChild = new EventEmitter() as unknown as ChildProcess;
    vi.mocked(spawn).mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('macOS: spawns "open" with the URL as argument', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const promise = openBrowser('https://example.com');
    // Emit spawn so the promise resolves
    mockChild.emit('spawn');
    await promise;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('open', ['https://example.com']);
  });

  it('Windows: spawns "start" with shell:true', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    const promise = openBrowser('https://example.com');
    mockChild.emit('spawn');
    await promise;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('start', ['""', 'https://example.com'], {
      shell: true,
    });
  });

  it('Linux: spawns "xdg-open" with the URL as argument', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });

    const promise = openBrowser('https://example.com');
    mockChild.emit('spawn');
    await promise;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('xdg-open', ['https://example.com']);
  });

  it('rejects on spawn error (e.g. command not found)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const error = new Error('ENOENT: command not found');
    const promise = openBrowser('https://example.com');
    mockChild.emit('error', error);

    await expect(promise).rejects.toThrow('ENOENT');
  });
});
