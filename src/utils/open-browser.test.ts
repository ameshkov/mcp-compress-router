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
    delete process.env.MCP_COMPRESS_ROUTER_BROWSER;
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

  it('uses the MCP_COMPRESS_ROUTER_BROWSER override when set', async () => {
    process.env.MCP_COMPRESS_ROUTER_BROWSER = 'node /path/to/mock.js --headless';

    const promise = openBrowser('https://example.com');
    mockChild.emit('spawn');
    await promise;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('node', [
      '/path/to/mock.js',
      '--headless',
      'https://example.com',
    ]);
  });

  it('MCP_COMPRESS_ROUTER_BROWSER takes precedence over the platform default', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.MCP_COMPRESS_ROUTER_BROWSER = 'firefox';

    const promise = openBrowser('https://example.com');
    mockChild.emit('spawn');
    await promise;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('firefox', ['https://example.com']);
  });

  it('ignores a blank MCP_COMPRESS_ROUTER_BROWSER and uses the platform default', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.MCP_COMPRESS_ROUTER_BROWSER = '   ';

    const promise = openBrowser('https://example.com');
    mockChild.emit('spawn');
    await promise;

    expect(spawn).toHaveBeenCalledWith('xdg-open', ['https://example.com']);
  });
});
