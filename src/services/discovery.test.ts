import { describe, it, expect } from 'vitest';
import { discoverSingleServer } from './index.js';
import type { DownstreamServerConfig } from '../utils/index.js';
import { Logger } from '../utils/index.js';
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

describe('discoverSingleServer', () => {
  it('ignores enabled:false and still probes the server', async () => {
    const resolved = await resolveCommand();
    const disabled: DownstreamServerConfig = {
      name: 'off',
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
      enabled: false,
    };

    const server = await discoverSingleServer(disabled, new Logger('error'));
    expect(server.name).toBe('off');
    expect(server.tools.length).toBeGreaterThan(0);
    const toolNames = server.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(['add', 'crash', 'echo', 'echo_env', 'failing_tool', 'multi_block']);
  });

  it('includes status ok on a successful discovery', async () => {
    const resolved = await resolveCommand();
    const config: DownstreamServerConfig = {
      name: 'on',
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
      enabled: true,
    };

    const server = await discoverSingleServer(config, new Logger('error'));
    expect(server.status).toBe('ok');
  });

  it('throws when the server is unreachable', async () => {
    const dead: DownstreamServerConfig = {
      name: 'dead',
      type: 'stdio',
      command: '/nonexistent/command',
    };
    await expect(discoverSingleServer(dead, new Logger('error'))).rejects.toThrow(/dead/);
  });
});
