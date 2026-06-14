import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectAndDiscover } from './index.js';
import type { DownstreamServerConfig } from '../utils/index.js';
import { Logger } from '../utils/index.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import type * as http from 'node:http';
import { createHttpFixtureServer } from '../../test/fixture-http-server.js';

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
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
    };

    const { servers } = await connectAndDiscover([config], new Logger('error'));
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('fixture');
    expect(servers[0].tools).toHaveLength(6);

    const toolNames = servers[0].tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(['add', 'crash', 'echo', 'echo_env', 'failing_tool', 'multi_block']);

    const echoTool = servers[0].tools.find((t) => t.name === 'echo')!;
    expect(echoTool.description).toBe('Returns the input message unchanged.');
    expect(echoTool.inputSchema).toHaveProperty('properties');
  });

  it('returns live clients keyed by server name', async () => {
    const resolved = await resolveCommand();
    const config: DownstreamServerConfig = {
      name: 'fixture',
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
    };

    const { clients } = await connectAndDiscover([config], new Logger('error'));
    expect(clients.has('fixture')).toBe(true);
    const client = clients.get('fixture')!;
    // Verify the client works for invocation
    const result = await client.callTool({
      name: 'echo',
      arguments: { message: 'hello' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      type: 'text',
      text: 'hello',
    });
  });

  it('propagates the configured env map to the spawned child process', async () => {
    const resolved = await resolveCommand();
    const config: DownstreamServerConfig = {
      name: 'fixture',
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
      env: { MCP_UNIT_PROPAGATED: 'reached-the-child' },
    };

    const { clients } = await connectAndDiscover([config], new Logger('error'));
    const client = clients.get('fixture')!;
    const result = await client.callTool({
      name: 'echo_env',
      arguments: { name: 'MCP_UNIT_PROPAGATED' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]).toMatchObject({
      type: 'text',
      text: 'reached-the-child',
    });
  });

  it('fails when a server is unreachable', async () => {
    const config: DownstreamServerConfig = {
      name: 'dead',
      type: 'stdio',
      command: '/nonexistent/command',
    };

    await expect(connectAndDiscover([config], new Logger('error'))).rejects.toThrow(/dead/);
  });

  it('connects to servers concurrently (slow server does not block fast one)', async () => {
    const resolved = await resolveCommand();
    const fastConfig: DownstreamServerConfig = {
      name: 'fast',
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
    };
    const slowConfig: DownstreamServerConfig = {
      name: 'slow',
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
      env: { ...process.env, FIXTURE_STARTUP_DELAY_MS: '2000' },
    };

    const start = Date.now();
    const { servers } = await connectAndDiscover([fastConfig, slowConfig], new Logger('error'));
    const elapsed = Date.now() - start;

    // Both servers should be discovered successfully
    expect(servers).toHaveLength(2);

    // Elapsed time must be under 3 seconds — proving parallelism.
    // If sequential, it would be 4+ seconds (2s slow + 2s overhead).
    expect(elapsed).toBeLessThan(3000);
  });
});

describe('connectAndDiscover — HTTP', () => {
  let httpServer: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const fixture = await createHttpFixtureServer();
    httpServer = fixture.server;
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('HTTP fixture server not listening');
    }
    baseUrl = `http://127.0.0.1:${addr.port}/mcp`;
  });

  afterAll(() => {
    httpServer.close();
  });

  it('discovers tools from an HTTP downstream server', async () => {
    const config: DownstreamServerConfig = {
      name: 'http-fixture',
      type: 'streamable-http',
      url: baseUrl,
    };

    const { servers } = await connectAndDiscover([config], new Logger('error'));
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('http-fixture');

    const toolNames = servers[0].tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(['add', 'check_auth', 'echo', 'failing_tool', 'multi_block']);
  });

  it('accepts type "http" as alias for "streamable-http"', async () => {
    const config: DownstreamServerConfig = {
      name: 'http-fixture-2',
      type: 'http',
      url: baseUrl,
    };

    const { servers } = await connectAndDiscover([config], new Logger('error'));
    expect(servers).toHaveLength(1);
    expect(servers[0].tools.length).toBeGreaterThan(0);
  });

  it('returns live clients for HTTP servers', async () => {
    const config: DownstreamServerConfig = {
      name: 'http-fixture',
      type: 'streamable-http',
      url: baseUrl,
    };

    const { clients } = await connectAndDiscover([config], new Logger('error'));
    expect(clients.has('http-fixture')).toBe(true);
    const client = clients.get('http-fixture')!;

    const result = await client.callTool({
      name: 'echo',
      arguments: { message: 'hello http' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]).toMatchObject({ type: 'text', text: 'hello http' });
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
