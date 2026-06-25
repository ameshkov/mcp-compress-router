import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import type * as http from 'node:http';
import {
  fixturePath,
  routerPath,
  resolveFixtureCommand,
  createHttpFixtureServer,
  getHttpFixtureUrl,
} from './helpers.js';

/** Spawn a CLI subcommand and capture stdout/stderr. */
function runCli(
  args: string[],
  homeDir: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn('node', [routerPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MCP_COMPRESS_ROUTER_HOME: homeDir },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

describe('CLI management commands', () => {
  let homeDir: string;
  let httpServer: http.Server;
  let httpUrl: string;

  beforeAll(async () => {
    homeDir = path.join(
      os.tmpdir(),
      `mcp-cli-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    httpServer = (await createHttpFixtureServer()).server;
    httpUrl = getHttpFixtureUrl(httpServer);
  });

  afterAll(async () => {
    httpServer.close();
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('list shows empty when no servers', async () => {
    const { stdout, exitCode } = await runCli(['list'], homeDir);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('Error');
  });

  it('add then get then list then remove lifecycle', async () => {
    // Add an HTTP server (local fixture — no OAuth metadata advertised)
    const addResult = await runCli(['add', '--transport', 'http', 'sentry', httpUrl], homeDir);
    expect(addResult.exitCode).toBe(0);
    expect(addResult.stdout).toContain('Added server "sentry"');

    // Add a stdio server
    const { command } = await resolveFixtureCommand();
    const addStdioResult = await runCli(
      [
        'add',
        '-e',
        'API_KEY=testkey',
        '--description',
        'Local fixture for testing',
        'fixture',
        command,
        fixturePath,
      ],
      homeDir,
    );
    expect(addStdioResult.exitCode).toBe(0);

    // Get the sentry server
    const getResult = await runCli(['get', 'sentry'], homeDir);
    expect(getResult.exitCode).toBe(0);
    expect(getResult.stdout).toContain('sentry');
    expect(getResult.stdout).toContain(httpUrl);

    // Description should appear in get output
    const getStdioResult = await runCli(['get', 'fixture'], homeDir);
    expect(getStdioResult.exitCode).toBe(0);
    expect(getStdioResult.stdout).toContain('Local fixture for testing');

    // List both servers
    const listResult = await runCli(['list'], homeDir);
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain('sentry');
    expect(listResult.stdout).toContain('fixture');
    expect(listResult.stdout).toContain('Enabled');
    expect(listResult.stdout).toContain('Tools');

    // Remove sentry
    const removeResult = await runCli(['remove', 'sentry'], homeDir);
    expect(removeResult.exitCode).toBe(0);
    expect(removeResult.stdout).toContain('Removed');

    // List again — should only show fixture
    const listAfter = await runCli(['list'], homeDir);
    expect(listAfter.stdout).toContain('fixture');
    expect(listAfter.stdout).not.toContain('sentry');

    // Get nonexistent should fail
    const getBad = await runCli(['get', 'nonexistent'], homeDir);
    expect(getBad.exitCode).toBe(1);
    expect(getBad.stderr).toContain('not found');
  });

  it('remove nonexistent server exits with error', async () => {
    const { exitCode, stderr } = await runCli(['remove', 'nonexistent'], homeDir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('not found');
  });

  it('add duplicate server exits with error', async () => {
    await runCli(['add', '--transport', 'http', 'dup', 'https://example.com/mcp'], homeDir);
    const { exitCode, stderr } = await runCli(
      ['add', '--transport', 'http', 'dup', 'https://other.com/mcp'],
      homeDir,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('already exists');
  });

  it('disable then enable round-trips the enabled field', async () => {
    // Seed a server in this test's own home (suite homeDir is shared)
    const seed = await runCli(['add', 'gh', 'node', '-e', 'TOKEN=abc'], homeDir);
    expect(seed.exitCode).toBe(0);

    const configPath = path.join(homeDir, 'mcp.json');
    const readConfig = async () => JSON.parse(await fs.readFile(configPath, 'utf-8'));

    // Disable: enabled: false should be written
    const disable1 = await runCli(['disable', 'gh'], homeDir);
    expect(disable1.exitCode).toBe(0);
    expect(disable1.stdout).toContain('Disabled server "gh"');
    expect((await readConfig()).mcpServers.gh.enabled).toBe(false);

    // Disable again — idempotent
    const disable2 = await runCli(['disable', 'gh'], homeDir);
    expect(disable2.exitCode).toBe(0);
    expect(disable2.stdout).toContain('already disabled');

    // Enable: field should be removed
    const enable1 = await runCli(['enable', 'gh'], homeDir);
    expect(enable1.exitCode).toBe(0);
    expect(enable1.stdout).toContain('Enabled server "gh"');
    expect((await readConfig()).mcpServers.gh).not.toHaveProperty('enabled');

    // Enable again — idempotent
    const enable2 = await runCli(['enable', 'gh'], homeDir);
    expect(enable2.exitCode).toBe(0);
    expect(enable2.stdout).toContain('already enabled');

    // Other fields preserved
    expect((await readConfig()).mcpServers.gh.command).toBe('node');

    // Cleanup so other tests don't see 'gh'
    await runCli(['remove', 'gh'], homeDir);
  });

  it('enable/disable nonexistent server exits with error', async () => {
    const en = await runCli(['enable', 'nonexistent'], homeDir);
    expect(en.exitCode).toBe(1);
    expect(en.stderr).toContain('not found');

    const dis = await runCli(['disable', 'nonexistent'], homeDir);
    expect(dis.exitCode).toBe(1);
    expect(dis.stderr).toContain('not found');
  });

  /** Read the parsed mcp.json written under the E2E home dir. */
  async function readE2eConfig(): Promise<{
    mcpServers: Record<string, Record<string, unknown>>;
  }> {
    const raw = await fs.readFile(path.join(homeDir, 'mcp.json'), 'utf-8');
    return JSON.parse(raw);
  }

  it('add --disabled --allowed-tools writes enabled:false and allowedTools', async () => {
    const { command } = await resolveFixtureCommand();
    const result = await runCli(
      ['add', '--disabled', '--allowed-tools', 'list_issues', 'gh', command, fixturePath],
      homeDir,
    );
    expect(result.exitCode).toBe(0);

    const config = await readE2eConfig();
    expect(config.mcpServers.gh.enabled).toBe(false);
    expect(config.mcpServers.gh.allowedTools).toEqual(['list_issues']);

    await runCli(['remove', 'gh'], homeDir);
  });

  it('add --disabled-tools writes disabledTools and no enabled field', async () => {
    const { command } = await resolveFixtureCommand();
    const result = await runCli(
      ['add', '--disabled-tools', 'delete_*', 'fs', command, fixturePath],
      homeDir,
    );
    expect(result.exitCode).toBe(0);

    const config = await readE2eConfig();
    expect(config.mcpServers.fs.enabled).toBeUndefined();
    expect(config.mcpServers.fs.disabledTools).toEqual(['delete_*']);

    await runCli(['remove', 'fs'], homeDir);
  });

  it('add with no selection flags writes a clean entry', async () => {
    const { command } = await resolveFixtureCommand();
    const result = await runCli(['add', 'plain', command, fixturePath], homeDir);
    expect(result.exitCode).toBe(0);

    const config = await readE2eConfig();
    expect(config.mcpServers.plain.enabled).toBeUndefined();
    expect(config.mcpServers.plain.allowedTools).toBeUndefined();
    expect(config.mcpServers.plain.disabledTools).toBeUndefined();

    await runCli(['remove', 'plain'], homeDir);
  });

  it('add rejects an invalid glob with non-zero exit and no write', async () => {
    const { command } = await resolveFixtureCommand();
    const result = await runCli(
      ['add', '--allowed-tools', '[unclosed', 'bad', command, fixturePath],
      homeDir,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('[unclosed');

    const { stdout } = await runCli(['list'], homeDir);
    expect(stdout).not.toContain('bad');
  });

  it('add rejects --enabled and --disabled together', async () => {
    const { command } = await resolveFixtureCommand();
    const result = await runCli(
      ['add', '--enabled', '--disabled', 'both', command, fixturePath],
      homeDir,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/--enabled.*--disabled/i);

    const { stdout } = await runCli(['list'], homeDir);
    expect(stdout).not.toContain('both');
  });
});
