import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { fixturePath, routerPath, resolveFixtureCommand } from './helpers.js';

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

  beforeAll(async () => {
    homeDir = path.join(
      os.tmpdir(),
      `mcp-cli-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
  });

  afterAll(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('list shows empty when no servers', async () => {
    const { stdout, exitCode } = await runCli(['list'], homeDir);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('Error');
  });

  it('add then get then list then remove lifecycle', async () => {
    // Add an HTTP server
    const addResult = await runCli(
      ['add', '--transport', 'http', 'sentry', 'https://mcp.sentry.dev/mcp'],
      homeDir,
    );
    expect(addResult.exitCode).toBe(0);
    expect(addResult.stdout).toContain('Added server "sentry"');

    // Add a stdio server
    const { command } = await resolveFixtureCommand();
    const addStdioResult = await runCli(
      ['add', '-e', 'API_KEY=testkey', 'fixture', command, fixturePath],
      homeDir,
    );
    expect(addStdioResult.exitCode).toBe(0);

    // Get the sentry server
    const getResult = await runCli(['get', 'sentry'], homeDir);
    expect(getResult.exitCode).toBe(0);
    expect(getResult.stdout).toContain('sentry');
    expect(getResult.stdout).toContain('https://mcp.sentry.dev/mcp');

    // List both servers
    const listResult = await runCli(['list'], homeDir);
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain('sentry');
    expect(listResult.stdout).toContain('fixture');

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
});
