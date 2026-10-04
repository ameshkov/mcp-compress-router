import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the fixture that hammers the shared credentials store. */
const writerPath = path.resolve(__dirname, '..', 'fixture-credentials-writer.ts');

/** tsx binary used to run the TypeScript fixture. */
const tsxPath = path.resolve('node_modules/.bin/tsx');

/** Spawn one writer process and resolve when it exits successfully. */
function spawnWriter(
  configPath: string,
  name: string,
  count: number,
  startFile: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(tsxPath, [writerPath, configPath, name, String(count), startFile], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`credentials writer "${name}" exited with ${code}: ${stderr}`));
      }
    });
  });
}

describe('credentials.json cross-process concurrency', () => {
  it('preserves the entries of every process writing at the same time', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-creds-e2e-'));
    try {
      const configPath = path.join(tmpDir, 'mcp.json');
      const startFile = path.join(tmpDir, 'start');
      await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }));

      // Eight processes start writing at the same instant and interleave
      // whole-file read-modify-write cycles on the same credentials.json;
      // without a cross-process lock, each process's writes drop the
      // entries written by the others.
      const names = Array.from({ length: 8 }, (_, index) => `proc-${index}`);
      const writers = names.map((name) => spawnWriter(configPath, name, 25, startFile));
      // Give every child time to load tsx and reach the start barrier.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await fs.writeFile(startFile, '');
      await Promise.all(writers);

      const raw = await fs.readFile(path.join(tmpDir, 'credentials.json'), 'utf-8');
      const store = JSON.parse(raw);
      for (const name of names) {
        expect(store[name]?.tokens?.access_token).toBe(`${name}-24`);
      }

      const leftovers = (await fs.readdir(tmpDir)).filter((entry) => entry.endsWith('.lock'));
      expect(leftovers).toEqual([]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
