#!/usr/bin/env node
/**
 * Prepares the QA router home used by the manual test plans.
 *
 * Creates `qa/home/` (gitignored), copies the committed baseline config
 * `qa/fixtures/mcp.jsonc` into it, and removes any runtime state
 * (`tools-cache.json`, `credentials.json`) so every scenario starts from
 * a clean home. Re-run it after a scenario modified the QA home.
 *
 * Usage: `pnpm qa:setup`
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOME_DIR = join(REPO_ROOT, 'qa', 'home');
const SOURCE = join(REPO_ROOT, 'qa', 'fixtures', 'mcp.jsonc');
const TARGET = join(HOME_DIR, 'mcp.jsonc');
const RUNTIME_FILES = ['tools-cache.json', 'credentials.json'];

/**
 * Resets the QA router home.
 */
async function main(): Promise<void> {
  await mkdir(HOME_DIR, { recursive: true });
  await cp(SOURCE, TARGET);
  for (const file of RUNTIME_FILES) {
    await rm(join(HOME_DIR, file), { force: true });
  }
  console.log(`QA router home ready: ${HOME_DIR}`);
  console.log(`Config: ${TARGET} (the baseline has no servers)`);
  console.log('Add a downstream server, for example:');
  console.log(
    "  pnpm qa:router add stdio-mock --description 'QA stdio mock' " +
      '-- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
