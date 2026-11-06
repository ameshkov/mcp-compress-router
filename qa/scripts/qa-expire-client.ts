#!/usr/bin/env node
/**
 * QA helper: marks a server's stored dynamic client registration as
 * expired by moving `client_secret_expires_at` into the past. The tokens
 * are left intact, so the next `login` must register a new client
 * instead of reusing the dead registration — an authorization server
 * rejects a token request that carries an expired client secret with
 * `invalid_client`.
 *
 * Used by the QA plan that verifies an expired client registration is
 * replaced at login. The mutation goes through the shared locked
 * credentials primitive, so it is safe to run while router containers
 * are live.
 *
 * Usage: pnpm qa:expire-client <server-name>
 *
 * Honors MCP_COMPRESS_ROUTER_HOME like the other QA commands; defaults
 * to qa/home.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutateCredentials } from '../../src/cli/config-io.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_HOME = join(REPO_ROOT, 'qa', 'home');

const serverName = process.argv[2];
if (!serverName) {
  console.error('Usage: pnpm qa:expire-client <server-name>');
  process.exit(1);
}

const home = process.env.MCP_COMPRESS_ROUTER_HOME ?? DEFAULT_HOME;
const configPath = join(home, existsSync(join(home, 'mcp.jsonc')) ? 'mcp.jsonc' : 'mcp.json');

try {
  await mutateCredentials(configPath, serverName, (current) => {
    if (!current?.clientRegistration) {
      throw new Error(`Server "${serverName}" has no stored client registration in ${home}.`);
    }
    return {
      ...current,
      clientRegistration: {
        ...current.clientRegistration,
        client_secret_expires_at: Math.floor(Date.now() / 1000) - 60,
      },
    };
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

console.log(`Marked the stored client registration of "${serverName}" as expired.`);
