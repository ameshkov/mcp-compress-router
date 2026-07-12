import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { saveToolCache, loadToolCache, clearToolCache } from './tool-cache.js';
import type { ToolDescriptor } from '../utils/index.js';

const sampleTools: ToolDescriptor[] = [
  {
    name: 'echo',
    description: 'Returns the input message unchanged.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'add',
    description: 'Adds two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

describe('saveToolCache + loadToolCache', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `mcp-cache-test-${Date.now()}-${Math.random()}`);
    await fs.mkdir(tempDir, { recursive: true });
    configPath = path.join(tempDir, 'mcp.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('saves and loads tools for a single server', async () => {
    await saveToolCache(configPath, 'figma', sampleTools);

    const loaded = await loadToolCache(configPath, 'figma');
    expect(loaded).toBeDefined();
    expect(loaded).toHaveLength(2);
    expect(loaded![0].name).toBe('echo');
    expect(loaded![1].name).toBe('add');
  });

  it('preserves tool descriptions and input schemas', async () => {
    await saveToolCache(configPath, 'figma', sampleTools);

    const [loaded] = (await loadToolCache(configPath, 'figma')) ?? [];
    expect(loaded?.description).toBe('Returns the input message unchanged.');
    expect(loaded?.inputSchema).toHaveProperty('properties.message');
    expect(loaded?.inputSchema).toHaveProperty('required', ['message']);
  });

  it('saves multiple servers independently', async () => {
    await saveToolCache(configPath, 'figma', sampleTools);
    await saveToolCache(configPath, 'github', [
      { name: 'list_issues', inputSchema: { type: 'object' } },
    ]);

    const figma = await loadToolCache(configPath, 'figma');
    const github = await loadToolCache(configPath, 'github');
    expect(figma).toHaveLength(2);
    expect(github).toHaveLength(1);
    expect(github![0].name).toBe('list_issues');
  });

  it('overwrites previous cache for the same server', async () => {
    await saveToolCache(configPath, 'figma', sampleTools);
    await saveToolCache(configPath, 'figma', [
      { name: 'new_tool', inputSchema: { type: 'object' } },
    ]);

    const loaded = await loadToolCache(configPath, 'figma');
    expect(loaded).toHaveLength(1);
    expect(loaded![0].name).toBe('new_tool');
  });

  it('returns undefined when no cache file exists', async () => {
    const loaded = await loadToolCache(configPath, 'figma');
    expect(loaded).toBeUndefined();
  });

  it('returns undefined when the server is not in the cache file', async () => {
    await saveToolCache(configPath, 'figma', sampleTools);
    const loaded = await loadToolCache(configPath, 'github');
    expect(loaded).toBeUndefined();
  });

  it('includes a cachedAt timestamp in the stored JSON', async () => {
    await saveToolCache(configPath, 'figma', sampleTools);

    const cachePath = path.join(tempDir, 'tools-cache.json');
    const raw = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
    expect(raw.figma).toHaveProperty('cachedAt');
    expect(typeof raw.figma.cachedAt).toBe('string');
    expect(Date.parse(raw.figma.cachedAt)).not.toBeNaN();
  });

  it('preserves every entry when many servers write concurrently', async () => {
    // At startup connectAllServers connects every enabled server in
    // parallel, and each successful connect calls saveToolCache. Without
    // serialization the read-modify-write calls race on the shared file
    // and only the last writer's entry survives. All entries must persist.
    const serverNames = Array.from({ length: 12 }, (_, i) => `srv-${i}`);
    await Promise.all(
      serverNames.map((name) =>
        saveToolCache(configPath, name, [
          { name: `tool-${name}`, inputSchema: { type: 'object' } },
        ]),
      ),
    );

    for (const name of serverNames) {
      const loaded = await loadToolCache(configPath, name);
      expect(loaded).toBeDefined();
      expect(loaded!.map((t) => t.name)).toEqual([`tool-${name}`]);
    }
  });
});

describe('clearToolCache', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `mcp-cache-clear-${Date.now()}-${Math.random()}`);
    await fs.mkdir(tempDir, { recursive: true });
    configPath = path.join(tempDir, 'mcp.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('removes a single server from the cache', async () => {
    await saveToolCache(configPath, 'figma', sampleTools);
    await saveToolCache(configPath, 'github', sampleTools);

    await clearToolCache(configPath, 'figma');

    const figma = await loadToolCache(configPath, 'figma');
    const github = await loadToolCache(configPath, 'github');
    expect(figma).toBeUndefined();
    expect(github).toHaveLength(2);
  });

  it('deletes the cache file when the last entry is removed', async () => {
    await saveToolCache(configPath, 'figma', sampleTools);

    await clearToolCache(configPath, 'figma');

    const cachePath = path.join(tempDir, 'tools-cache.json');
    await expect(fs.access(cachePath)).rejects.toThrow();
  });

  it('is a no-op when the cache file does not exist', async () => {
    await expect(clearToolCache(configPath, 'figma')).resolves.not.toThrow();
  });

  it('is a no-op when the server is not in the cache', async () => {
    await saveToolCache(configPath, 'figma', sampleTools);
    await expect(clearToolCache(configPath, 'github')).resolves.not.toThrow();
    const figma = await loadToolCache(configPath, 'figma');
    expect(figma).toHaveLength(2);
  });
});
