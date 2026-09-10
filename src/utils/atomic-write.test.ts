import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWriteFile } from './atomic-write.js';

describe('atomicWriteFile', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `atomic-write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    filePath = path.join(tempDir, 'target.json');
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates the file with the given content', async () => {
    await atomicWriteFile(filePath, '{"hello":"world"}\n');

    expect(await fs.readFile(filePath, 'utf-8')).toBe('{"hello":"world"}\n');
  });

  it('overwrites an existing file and leaves no temporary files behind', async () => {
    await atomicWriteFile(filePath, 'old');
    await atomicWriteFile(filePath, 'new');

    expect(await fs.readFile(filePath, 'utf-8')).toBe('new');
    const leftovers = (await fs.readdir(tempDir)).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('applies the requested mode to the written file', async () => {
    await atomicWriteFile(filePath, 'secret', 0o600);

    // chmod is a no-op on Windows, so the mode check is Unix-only.
    if (process.platform !== 'win32') {
      const stat = await fs.stat(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('removes the temporary file when the rename fails', async () => {
    // A directory cannot be replaced by rename(2), so the write fails
    // after the temporary file has been created.
    const dirPath = path.join(tempDir, 'target-dir');
    await fs.mkdir(dirPath);

    await expect(atomicWriteFile(dirPath, 'data')).rejects.toThrow();

    const leftovers = (await fs.readdir(tempDir)).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
    expect((await fs.stat(dirPath)).isDirectory()).toBe(true);
  });

  it('never leaves torn content under concurrent writes', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => atomicWriteFile(filePath, `value-${i}\n`)),
    );

    expect(await fs.readFile(filePath, 'utf-8')).toMatch(/^value-\d+\n$/);
    const leftovers = (await fs.readdir(tempDir)).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});
