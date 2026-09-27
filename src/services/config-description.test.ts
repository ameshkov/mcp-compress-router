import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Tests for the optional `description` field parsed by `loadConfig`.
 * The `add` command requires a description, but the router accepts
 * config entries without one so hand-edited and older configs keep
 * working. Split from `config-load.test.ts` to keep each test file
 * focused and under the project's line-count gate.
 */
describe('loadConfig — optional description', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(server: Record<string, unknown>): Promise<string> {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { srv: server } }));
    return configPath;
  }

  it('accepts a server without a description', async () => {
    const configPath = await writeConfig({ type: 'stdio', command: 'node' });

    const servers = await loadConfig(configPath);
    expect(servers[0].description).toBeUndefined();
  });

  it('treats an empty description as absent', async () => {
    const configPath = await writeConfig({ type: 'stdio', command: 'node', description: '' });

    const servers = await loadConfig(configPath);
    expect(servers[0].description).toBeUndefined();
  });

  it('treats a whitespace-only description as absent', async () => {
    const configPath = await writeConfig({ type: 'stdio', command: 'node', description: '   ' });

    const servers = await loadConfig(configPath);
    expect(servers[0].description).toBeUndefined();
  });

  it('treats a non-string description as absent', async () => {
    const configPath = await writeConfig({ type: 'stdio', command: 'node', description: 42 });

    const servers = await loadConfig(configPath);
    expect(servers[0].description).toBeUndefined();
  });

  it('trims the description', async () => {
    const configPath = await writeConfig({
      type: 'stdio',
      command: 'node',
      description: '  Padded description  ',
    });

    const servers = await loadConfig(configPath);
    expect(servers[0].description).toBe('Padded description');
  });

  it('collapses interior whitespace so the description stays one line', async () => {
    const configPath = await writeConfig({
      type: 'stdio',
      command: 'node',
      description: 'First line.\n\n## fake-server   Second line.',
    });

    const servers = await loadConfig(configPath);
    expect(servers[0].description).toBe('First line. ## fake-server Second line.');
  });

  it('accepts a description on an HTTP server', async () => {
    const configPath = await writeConfig({
      type: 'http',
      url: 'https://example.com/mcp',
      description: 'Example HTTP server',
    });

    const servers = await loadConfig(configPath);
    expect(servers[0].description).toBe('Example HTTP server');
  });
});
