import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { OAuthCredentialManager } from './oauth.js';
import { readCredentials, writeCredentials } from '../cli/config-io.js';
import { createAuthFixtureServer, type AuthFixtureServer } from '../../test/fixture-auth-server.js';
import { resolveServerTimeouts } from '../utils/index.js';
import type { DownstreamServerConfig } from '../utils/types.js';

describe('OAuthCredentialManager refresh against a real authorization server', () => {
  let fixture: AuthFixtureServer;
  let tmpDir: string;
  let configPath: string;
  let server: DownstreamServerConfig;

  beforeEach(async () => {
    fixture = await createAuthFixtureServer();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-refresh-integration-'));
    configPath = path.join(tmpDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }));
    server = {
      name: 'auth-fixture',
      description: 'OAuth fixture server',
      type: 'http',
      url: `${fixture.url}/mcp`,
      timeout: resolveServerTimeouts(),
    };
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      fixture.server.close(() => resolve());
    });
    await fs.rm(tmpDir, { recursive: true });
  });

  /**
   * Seeds credentials whose access token the fixture never issued, with
   * a far-future expiry so proactive refresh cannot fire: only the 401
   * path can trigger a refresh.
   */
  async function seedUnissuedTokens(): Promise<void> {
    await writeCredentials(configPath, server.name, {
      clientRegistration: { client_id: 'seed-client' },
      tokens: {
        access_token: 'at-stale',
        token_type: 'Bearer',
        refresh_token: 'rt-stale',
        expires_in: 3600,
        scope: 'read write',
        expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      },
      authRequirement: 'oauth',
      checkedAt: new Date().toISOString(),
    });
  }

  it('refreshes a rejected access token exactly once across managers sharing a credentials file', async () => {
    await seedUnissuedTokens();
    // The provider invalidates every previously issued access token on
    // refresh, like the providers that drive the refresh storm.
    fixture.invalidatePreviousAccessToken();
    const first = new OAuthCredentialManager(configPath, server);
    const second = new OAuthCredentialManager(configPath, server);

    const [firstTokens, secondTokens] = await Promise.all([
      first.refreshAfterUnauthorized('at-stale'),
      second.refreshAfterUnauthorized('at-stale'),
    ]);

    // The cross-process refresh lock serializes the two managers: the
    // winner refreshes, the loser adopts the winner's token instead of
    // presenting the same refresh token again.
    expect(fixture.getTokenRequestCount()).toBe(1);
    expect(firstTokens?.access_token).toBeDefined();
    expect(secondTokens?.access_token).toBe(firstTokens?.access_token);
    expect(fixture.isAccessTokenValid(firstTokens!.access_token)).toBe(true);
    expect(fixture.isAccessTokenValid('at-stale')).toBe(false);
    // The refresh carried the RFC 8707 resource indicator published in
    // the fixture's Protected Resource Metadata.
    expect(fixture.getLastTokenResource()).toBe(`${fixture.url}/mcp`);
    // The fresh token is persisted for the next router instance.
    const store = await readCredentials(configPath);
    expect(store[server.name]?.tokens?.access_token).toBe(firstTokens?.access_token);
  });

  it('adopts a changed token on the next call without another token request', async () => {
    await seedUnissuedTokens();
    fixture.invalidatePreviousAccessToken();
    const first = new OAuthCredentialManager(configPath, server);
    const second = new OAuthCredentialManager(configPath, server);

    const refreshed = await first.refreshAfterUnauthorized('at-stale');
    expect(fixture.getTokenRequestCount()).toBe(1);

    // The stored token now differs from the one the second manager was
    // called with, so it is adopted without contacting the token
    // endpoint again.
    const adopted = await second.refreshAfterUnauthorized('at-stale');

    expect(adopted?.access_token).toBe(refreshed?.access_token);
    expect(fixture.getTokenRequestCount()).toBe(1);
  });

  it('invalidates the previously issued token when the provider rotates on refresh', async () => {
    await seedUnissuedTokens();
    fixture.invalidatePreviousAccessToken();
    const mgr = new OAuthCredentialManager(configPath, server);

    const first = await mgr.refreshAfterUnauthorized('at-stale');
    expect(fixture.getTokenRequestCount()).toBe(1);
    expect(fixture.isAccessTokenValid(first!.access_token)).toBe(true);

    // The second 401 carries the token the first refresh stored, so a
    // second refresh runs, and the provider drops the previously issued
    // token when it rotates.
    const second = await mgr.refreshAfterUnauthorized(first!.access_token);

    expect(fixture.getTokenRequestCount()).toBe(2);
    expect(fixture.isAccessTokenValid(first!.access_token)).toBe(false);
    expect(fixture.isAccessTokenValid(second!.access_token)).toBe(true);
  });
});
