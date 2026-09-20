#!/usr/bin/env node
/**
 * Router management CLI wrapper for the manual QA stack.
 *
 * Forwards every argument to the compiled router (`build/index.js`) with
 * `MCP_COMPRESS_ROUTER_HOME` pointing at the QA home (`qa/home`), so
 * the plans can manage the QA configuration without repeating the
 * environment variable:
 *
 *   pnpm qa:router add stdio-mock --description 'QA stdio mock' \
 *     -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts
 *   pnpm qa:router list
 *   pnpm qa:router enable archive
 *
 * Run `pnpm qa:setup` first to reset the QA home.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTER_ENTRY = resolve(REPO_ROOT, 'build', 'index.js');
const DEFAULT_HOME = join(REPO_ROOT, 'qa', 'home');

/**
 * Runs the router CLI with the QA home.
 */
function main(): void {
  if (!existsSync(ROUTER_ENTRY)) {
    console.error(`Router build not found: ${ROUTER_ENTRY}\nRun "pnpm build" first.`);
    process.exit(1);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MCP_COMPRESS_ROUTER_HOME: process.env.MCP_COMPRESS_ROUTER_HOME ?? DEFAULT_HOME,
  };
  const child = spawn(process.execPath, [ROUTER_ENTRY, ...process.argv.slice(2)], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  });
  child.once('error', (err: Error) => {
    console.error(`Failed to start the router CLI: ${err.message}`);
    process.exit(1);
  });
  child.once('exit', (code, signal) => {
    process.exit(code ?? (signal === null ? 0 : 1));
  });
}

main();
