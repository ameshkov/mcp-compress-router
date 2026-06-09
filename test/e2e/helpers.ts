import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import type * as http from 'node:http';
import { createHttpFixtureServer } from '../fixture-http-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the fixture MCP server. */
export const fixturePath = path.resolve(__dirname, '..', 'fixture-server.ts');

/** Absolute path to the compiled router entry point. */
export const routerPath = path.resolve(__dirname, '..', '..', 'build', 'index.js');

/** Check whether a file exists at the given path. */
export async function nodeExists(cmd: string): Promise<boolean> {
  try {
    await fs.access(cmd);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the command (tsx or node) and args to run the fixture server. */
export async function resolveFixtureCommand(): Promise<{
  command: string;
  args: string[];
}> {
  const tsxCommand = path.resolve('node_modules/.bin/tsx');
  if (await nodeExists(tsxCommand)) {
    return { command: tsxCommand, args: [fixturePath] };
  }
  return { command: 'node', args: [fixturePath.replace('.ts', '.js')] };
}

/**
 * Spawn the router as a subprocess and wait for it to exit.
 * Used by fail-fast tests that expect the router to exit immediately.
 */
export function spawnRouter(
  configPath: string,
  homeDir: string,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [routerPath, '--config', configPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MCP_COMPRESS_ROUTER_HOME: homeDir },
    });

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Consume stdout so the process doesn't block
    proc.stdout?.on('data', () => {});

    proc.on('close', (code) => {
      resolve({ exitCode: code ?? -1, stderr });
    });

    proc.on('error', reject);
  });
}

export { createHttpFixtureServer };

/**
 * Get the base URL for a running HTTP fixture server.
 */
export function getHttpFixtureUrl(server: http.Server): string {
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('HTTP fixture server not listening');
  }
  return `http://127.0.0.1:${addr.port}/mcp`;
}
