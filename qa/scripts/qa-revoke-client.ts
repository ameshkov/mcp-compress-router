#!/usr/bin/env node
/**
 * QA helper: makes the mock OAuth provider forget a server's stored
 * dynamic client registration. The mock then rejects that `client_id`
 * with `invalid_client` at its authorization and token endpoints, like a
 * provider whose registration database no longer knows the client. The
 * stored credentials are left untouched. A later `login` reuses the
 * stored registration after local checks and does not probe the
 * provider: when the provider rejects the client on the authorization
 * page, the login waits for a callback that never arrives. Force a
 * runtime token request instead (for example, `pnpm qa:reject-token`
 * followed by a probe) so the refresh discards the registration, or run
 * `logout` before `login`.
 *
 * Used by the QA plans that verify the discard of a provider-revoked
 * registration through a runtime refresh or a login token exchange. The
 * mock control endpoint mutates only in-memory mock state.
 *
 * Usage: pnpm qa:revoke-client <server-name>
 *
 * Honors MCP_COMPRESS_ROUTER_HOME like the other QA commands; defaults
 * to qa/home. Honors QA_OAUTH_MOCK_URL for the mock address; defaults to
 * the Compose service name.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCredentials } from '../../src/cli/config-io.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_HOME = join(REPO_ROOT, 'qa', 'home');
const DEFAULT_MOCK_URL = 'http://mock-mcp-http-oauth:3101';

const serverName = process.argv[2];
if (!serverName) {
  console.error('Usage: pnpm qa:revoke-client <server-name>');
  process.exit(1);
}

const home = process.env.MCP_COMPRESS_ROUTER_HOME ?? DEFAULT_HOME;
const configPath = join(home, existsSync(join(home, 'mcp.jsonc')) ? 'mcp.jsonc' : 'mcp.json');
const mockUrl = process.env.QA_OAUTH_MOCK_URL ?? DEFAULT_MOCK_URL;

try {
  const store = await readCredentials(configPath);
  const clientId = store[serverName]?.clientRegistration?.client_id;
  if (typeof clientId !== 'string' || clientId === '') {
    throw new Error(`Server "${serverName}" has no stored client registration in ${home}.`);
  }
  const response = await fetch(`${mockUrl}/test/revoke-client`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!response.ok) {
    throw new Error(`The mock provider rejected the revoke request (HTTP ${response.status}).`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

console.log(`Revoked the stored client registration of "${serverName}" at the mock provider.`);
