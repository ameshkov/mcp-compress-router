import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import type * as http from 'node:http';
import { handleTools } from './tools-command.js';
import { createHttpFixtureServer } from '../../test/fixture-http-server.js';
import { writeCredentials } from './config-io.js';

const tsxCommand = path.resolve('node_modules/.bin/tsx');
const fixturePath = path.resolve('test', 'fixture-server.ts');

async function resolveCommand(): Promise<{ command: string; args: string[] }> {
  try {
    await fs.access(tsxCommand);
    return { command: tsxCommand, args: [fixturePath] };
  } catch {
    return { command: 'node', args: [fixturePath.replace('.ts', '.js')] };
  }
}

describe('handleTools — stdio fixture', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `cli-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
    configPath = path.join(tempDir, 'mcp.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeConfig(server: Record<string, unknown>): Promise<void> {
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { fs: server } }));
  }

  it('lists every advertised tool marked [exposed] when no selection is set', async () => {
    const resolved = await resolveCommand();
    await writeConfig({
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
    });

    const out = await handleTools(configPath, 'fs');
    expect(out).toContain('[exposed]');
    expect(out).not.toContain('[filtered]');
    // Every fixture tool appears with its description.
    expect(out).toContain('echo');
    expect(out).toContain('Returns the input message unchanged.');
    expect(out).toContain('add');
    expect(out).toContain('failing_tool');
    expect(out).toContain('multi_block');
  });

  it('marks tools matching disabledTools as [filtered]', async () => {
    const resolved = await resolveCommand();
    await writeConfig({
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
      disabledTools: ['crash', 'failing_*'],
    });

    const out = await handleTools(configPath, 'fs');
    // crash and failing_tool are filtered; the rest are exposed.
    const lines = out.split('\n');
    const crashLine = lines.find((l) => l.includes('crash'))!;
    expect(crashLine).toContain('[filtered]');
    const failingLine = lines.find((l) => l.includes('failing_tool'))!;
    expect(failingLine).toContain('[filtered]');
    const echoLine = lines.find((l) => l.trim().startsWith('echo'))!;
    expect(echoLine).toContain('[exposed]');
  });

  it('marks only allowedTools entries as [exposed]', async () => {
    const resolved = await resolveCommand();
    await writeConfig({
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
      allowedTools: ['echo', 'add'],
    });

    const out = await handleTools(configPath, 'fs');
    const lines = out.split('\n');
    expect(lines.find((l) => l.trim().startsWith('echo'))!).toContain('[exposed]');
    expect(lines.find((l) => l.trim().startsWith('add'))!).toContain('[exposed]');
    expect(lines.find((l) => l.includes('crash'))!).toContain('[filtered]');
    expect(lines.find((l) => l.includes('multi_block'))!).toContain('[filtered]');
  });

  it('probes the server even when enabled is false', async () => {
    const resolved = await resolveCommand();
    await writeConfig({
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
      enabled: false,
    });

    const out = await handleTools(configPath, 'fs');
    expect(out).toContain('echo');
    expect(out).toContain('[exposed]');
  });

  it('throws "server not found" for an unknown name', async () => {
    await writeConfig({ type: 'stdio', command: 'echo' });
    await expect(handleTools(configPath, 'nope')).rejects.toThrow('Server "nope" not found');
  });

  it('throws on an unreachable stdio command', async () => {
    await writeConfig({ type: 'stdio', command: '/nonexistent/command' });
    await expect(handleTools(configPath, 'fs')).rejects.toThrow(/fs/);
  });

  it('renders a clear message (not a crash) when the server advertises no tools', async () => {
    const resolved = await resolveCommand();
    await writeConfig({
      type: 'stdio',
      command: resolved.command,
      args: resolved.args,
      env: { FIXTURE_EMPTY_TOOLS: '1' },
    });

    const out = await handleTools(configPath, 'fs');
    expect(out).toContain('server advertises no tools');
    expect(out).not.toContain('[exposed]');
    expect(out).not.toContain('[filtered]');
  });
});

describe('handleTools — HTTP fixture', () => {
  let httpServer: http.Server;
  let getLastAuthHeader: () => string | undefined;
  let baseUrl: string;
  let tempDir: string;
  let configPath: string;

  beforeAll(async () => {
    const fixture = await createHttpFixtureServer();
    httpServer = fixture.server;
    getLastAuthHeader = fixture.getLastAuthHeader;
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('HTTP fixture server not listening');
    }
    baseUrl = `http://127.0.0.1:${addr.port}/mcp`;
  });

  afterAll(() => {
    httpServer.close();
  });

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `cli-tools-http-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });
    configPath = path.join(tempDir, 'mcp.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('lists tools from a public HTTP server', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { http: { type: 'streamable-http', url: baseUrl } },
      }),
    );

    const out = await handleTools(configPath, 'http');
    expect(out).toContain('echo');
    expect(out).toContain('[exposed]');
  });

  it('throws on an unreachable HTTP URL with no partial output', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          http: { type: 'streamable-http', url: 'http://127.0.0.1:1/mcp' },
        },
      }),
    );
    await expect(handleTools(configPath, 'http')).rejects.toThrow(/http/);
  });

  it('authenticates with stored OAuth credentials and forwards the bearer token', async () => {
    // Pre-seed credentials.json with stored tokens for the http server.
    // This exercises buildSingleAuthProvider's hasCredentials branch: it
    // constructs an OAuthCredentialManager (since mgr.tokens() returns the
    // seeded tokens) and passes it to discoverSingleServer, which forwards
    // the access token as a Bearer Authorization header to the fixture.
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { http: { type: 'streamable-http', url: baseUrl } },
      }),
    );
    await writeCredentials(configPath, 'http', {
      authRequirement: 'oauth',
      checkedAt: new Date().toISOString(),
      tokens: { access_token: 'seeded-at-456', token_type: 'Bearer' },
    });

    const out = await handleTools(configPath, 'http');

    // The probe authenticates and lists tools normally.
    expect(out).toContain('echo');
    expect(out).toContain('[exposed]');

    // The fixture captured an Authorization header proving the stored
    // access token was forwarded through the OAuthCredentialManager path.
    expect(getLastAuthHeader()).toBe('Bearer seeded-at-456');
  });

  it('constructs an OAuthCredentialManager from oauth overrides even without stored tokens', async () => {
    // Configure oauth overrides (clientId only). buildSingleAuthProvider's
    // hasOverrides branch fires: an OAuthCredentialManager is constructed
    // despite the absence of stored tokens. The fixture is public so the
    // connection succeeds and tools are listed (no bearer token forwarded
    // since there are no tokens, but the manager path is taken).
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          http: {
            type: 'streamable-http',
            url: baseUrl,
            oauth: { clientId: 'override-client-id' },
          },
        },
      }),
    );

    const out = await handleTools(configPath, 'http');
    expect(out).toContain('echo');
    expect(out).toContain('[exposed]');
  });
});
