import { describe, it, expect } from 'vitest';
import { connectAndDiscover } from './index.js';
import type { DownstreamServerConfig } from '../utils/index.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, '..', '..', 'test', 'fixture-server.ts');

// Use tsx to run the fixture TypeScript directly
const tsxCommand = path.resolve('node_modules/.bin/tsx');

async function nodeExists(cmd: string): Promise<boolean> {
  try {
    await fs.access(cmd);
    return true;
  } catch {
    return false;
  }
}

describe('connectAndDiscover', () => {
  it('discovers tools from a stdio fixture server', async () => {
    const resolved = await resolveCommand();
    const config: DownstreamServerConfig = {
      name: 'fixture',
      command: resolved.command,
      args: resolved.args,
    };

    const result = await connectAndDiscover([config]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('fixture');
    expect(result[0].tools).toHaveLength(2);

    const toolNames = result[0].tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(['add', 'echo']);

    const echoTool = result[0].tools.find((t) => t.name === 'echo')!;
    expect(echoTool.description).toBe('Returns the input message unchanged.');
    expect(echoTool.inputSchema).toHaveProperty('properties');
  });

  it('fails when a server is unreachable', async () => {
    const config: DownstreamServerConfig = {
      name: 'dead',
      command: '/nonexistent/command',
    };

    await expect(connectAndDiscover([config])).rejects.toThrow(/dead/);
  });
});

async function resolveCommand(): Promise<{
  command: string;
  args: string[];
}> {
  // Prefer tsx if available
  if (await nodeExists(tsxCommand)) {
    return { command: tsxCommand, args: [fixturePath] };
  }
  // Fall back to node with compiled fixture
  return { command: 'node', args: [fixturePath.replace('.ts', '.js')] };
}
