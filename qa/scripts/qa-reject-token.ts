#!/usr/bin/env node
/**
 * QA helper: simulates an access token the OAuth provider no longer
 * accepts. The stored `access_token` is replaced with an unknown value
 * and `expires_at` is moved into the past, while the `refresh_token` is
 * left intact — so the next router call must refresh the tokens and the
 * downstream mock answers 401 until it does.
 *
 * With `--keep-expiry`, `expires_at` is left untouched instead, so
 * proactive refresh cannot fire and only the provider's 401 can trigger
 * the refresh.
 *
 * Used by the QA plans that reject a stored token and then verify the
 * router recovers through a coordinated refresh. The mutation goes
 * through the shared locked credentials primitive, so it is safe to run
 * while router containers are live.
 *
 * Usage: pnpm qa:reject-token <server-name> [--keep-expiry]
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

const args = process.argv.slice(2);
const keepExpiry = args.includes('--keep-expiry');
const serverName = args.find((arg) => arg !== '--keep-expiry');
if (!serverName) {
  console.error('Usage: pnpm qa:reject-token <server-name> [--keep-expiry]');
  process.exit(1);
}

const home = process.env.MCP_COMPRESS_ROUTER_HOME ?? DEFAULT_HOME;
const credPath = join(home, 'credentials.json');
// `mutateCredentials` anchors the shared credentials store by the config
// path's directory, so the home's existing config file is used only as
// the anchor; the credentials path stays `credentials.json` next to it.
const configPath = join(home, existsSync(join(home, 'mcp.jsonc')) ? 'mcp.jsonc' : 'mcp.json');

try {
  await mutateCredentials(configPath, serverName, (current) => {
    if (!current?.tokens?.refresh_token) {
      throw new Error(`Server "${serverName}" has no stored refresh token in ${credPath}.`);
    }
    return {
      ...current,
      tokens: {
        ...current.tokens,
        access_token: `qa-rejected-${Date.now()}`,
        ...(keepExpiry ? {} : { expires_at: new Date(Date.now() - 3_600_000).toISOString() }),
      },
    };
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

console.log(
  keepExpiry
    ? `Marked the stored access token of "${serverName}" as rejected (expiry kept).`
    : `Marked the stored access token of "${serverName}" as rejected.`,
);
