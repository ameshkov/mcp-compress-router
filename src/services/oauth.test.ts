import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { OAuthCredentialManager, OAUTH_CALLBACK_PATH, OAUTH_LOOPBACK_URI } from './oauth.js';
import { GuidedAuthError } from './index.js';
import { readCredentials, writeCredentials } from '../cli/config-io.js';
import { resolveServerTimeouts } from '../utils/index.js';
import type { DownstreamServerConfig } from '../utils/types.js';

describe('OAuthCredentialManager', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-test-'));
    configPath = path.join(tmpDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  const server: DownstreamServerConfig = {
    name: 'test-server',
    description: 'Test OAuth server',
    type: 'http',
    url: 'https://example.com/mcp',
    timeout: resolveServerTimeouts(),
  };

  it('redirectUrl returns loopback URL with actual port after setActualPort', () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    mgr.setActualPort(54321);
    expect(mgr.redirectUrl).toBe(`http://127.0.0.1:54321${OAUTH_CALLBACK_PATH}`);
  });

  it('redirectUrl returns fallback port 0 before setActualPort is called', () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    expect(mgr.redirectUrl).toBe(`http://127.0.0.1:0${OAUTH_CALLBACK_PATH}`);
  });

  it('clientMetadata registers the loopback callback URI without a port', () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    expect(new URL(mgr.clientMetadata.redirect_uris[0]).port).toBe('');
    mgr.setActualPort(54321);
    expect(mgr.clientMetadata.client_name).toBe('mcp-compress-router');
    expect(mgr.clientMetadata.redirect_uris).toEqual([OAUTH_LOOPBACK_URI]);
    // The registered URI must stay portless after the callback server
    // binds: RFC 8252 §8.4 excludes the port from loopback redirect
    // matching, so one registration stays valid across logins.
    expect(new URL(mgr.clientMetadata.redirect_uris[0]).port).toBe('');
    // Native clients must declare application_type so OIDC-aware
    // registration endpoints do not default to "web".
    expect(mgr.clientMetadata.application_type).toBe('native');
    // client_uri is omitted unless the server overrides it.
    expect(mgr.clientMetadata.client_uri).toBeUndefined();
  });

  it('clientMetadata applies the oauth.clientName and oauth.clientUri overrides', () => {
    const mgr = new OAuthCredentialManager(configPath, {
      ...server,
      oauth: { clientName: 'Visual Studio Code', clientUri: 'https://code.visualstudio.com' },
    });
    expect(mgr.clientMetadata.client_name).toBe('Visual Studio Code');
    expect(mgr.clientMetadata.client_uri).toBe('https://code.visualstudio.com');
    expect(mgr.clientMetadata.redirect_uris).toEqual([OAUTH_LOOPBACK_URI]);
    expect(mgr.clientMetadata.application_type).toBe('native');
  });

  it('clientInformation returns undefined when no credentials stored', async () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    expect(await mgr.clientInformation()).toBeUndefined();
  });

  it('saveClientInformation and clientInformation round-trip', async () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    const info = {
      client_id: 'test-client',
      client_secret: 'test-secret',
      redirect_uris: [new URL('http://localhost/callback')],
    };
    await mgr.saveClientInformation(info);
    const loaded = await mgr.clientInformation();
    expect(loaded).toBeDefined();
    expect(loaded!.client_id).toBe('test-client');
  });

  it('tokens returns undefined when no credentials stored', async () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    expect(await mgr.tokens()).toBeUndefined();
  });

  it('saveTokens and tokens round-trip', async () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    const tokens = {
      access_token: 'at-123',
      token_type: 'Bearer' as const,
      refresh_token: 'rt-456',
      expires_in: 3600,
      scope: 'read',
    };
    await mgr.saveTokens(tokens);
    const loaded = await mgr.tokens();
    expect(loaded).toBeDefined();
    expect(loaded!.access_token).toBe('at-123');
  });

  it('saveCodeVerifier and codeVerifier round-trip', async () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.saveCodeVerifier('test-verifier');
    expect(await mgr.codeVerifier()).toBe('test-verifier');
  });

  it('clearTokens removes all stored state', async () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.saveTokens({
      access_token: 'at-123',
      token_type: 'Bearer',
    });
    await mgr.clearTokens();
    expect(await mgr.tokens()).toBeUndefined();
    expect(await mgr.clientInformation()).toBeUndefined();
  });

  it('clearTokens preserves cached authRequirement on logout', async () => {
    // Seed a fully authenticated entry that also carries a cached
    // auth requirement.
    await writeCredentials(configPath, server.name, {
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
      tokens: { access_token: 'at-123', token_type: 'Bearer' },
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.clearTokens();

    expect(await mgr.tokens()).toBeUndefined();
    expect(await mgr.clientInformation()).toBeUndefined();

    // The entry survives with only the cached auth requirement.
    const store = await readCredentials(configPath);
    expect(store[server.name]).toEqual({
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });
  });

  it('saveTokens sets authRequirement to oauth after successful token exchange', async () => {
    await writeCredentials(configPath, server.name, {
      authRequirement: 'none',
      checkedAt: '2026-06-22T12:00:00Z',
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.saveTokens({ access_token: 'at-456', token_type: 'Bearer' });

    const store = await readCredentials(configPath);
    // After a successful OAuth token exchange, the auth requirement
    // is updated to 'oauth' with a fresh timestamp, overriding any
    // stale value (e.g. 'none' from a failed startup probe).
    expect(store[server.name]?.authRequirement).toBe('oauth');
    expect(store[server.name]?.checkedAt).toBeDefined();
    expect(store[server.name]?.tokens?.access_token).toBe('at-456');
  });

  it('saveTokens stores expires_at derived from expires_in', async () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.saveTokens({
      access_token: 'at-123',
      token_type: 'Bearer',
      refresh_token: 'rt-456',
      expires_in: 3600,
    });

    const store = await readCredentials(configPath);
    const expiresAt = store[server.name]?.tokens?.expires_at;
    expect(expiresAt).toBeDefined();
    // The stored expiry should be ~3600s in the future.
    const expectedMs = Date.now() + 3600 * 1000;
    const actualMs = Date.parse(expiresAt!);
    expect(actualMs).toBeGreaterThan(expectedMs - 5000);
    expect(actualMs).toBeLessThan(expectedMs + 5000);
  });

  it('saveTokens omits expires_at when expires_in is undefined', async () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.saveTokens({ access_token: 'at-123', token_type: 'Bearer' });

    const store = await readCredentials(configPath);
    expect(store[server.name]?.tokens?.expires_at).toBeUndefined();
  });

  it('invalidateCredentials("tokens") clears tokens but preserves client registration and auth requirement', async () => {
    await writeCredentials(configPath, server.name, {
      clientRegistration: { client_id: 'reg-id' },
      tokens: { access_token: 'at-123', token_type: 'Bearer' },
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.invalidateCredentials('tokens');

    expect(await mgr.tokens()).toBeUndefined();
    // Client registration survives so the next login can reuse DCR.
    expect(await mgr.clientInformation()).toEqual({ client_id: 'reg-id' });

    const store = await readCredentials(configPath);
    expect(store[server.name]?.tokens).toBeUndefined();
    expect(store[server.name]?.authRequirement).toBe('oauth');
  });

  it('invalidateCredentials("client") clears client registration but preserves tokens', async () => {
    await writeCredentials(configPath, server.name, {
      clientRegistration: { client_id: 'reg-id' },
      tokens: { access_token: 'at-123', token_type: 'Bearer' },
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.invalidateCredentials('client');

    expect(await mgr.clientInformation()).toBeUndefined();
    // Tokens survive so the access token remains usable until expiry.
    const loaded = await mgr.tokens();
    expect(loaded?.access_token).toBe('at-123');

    const store = await readCredentials(configPath);
    expect(store[server.name]?.clientRegistration).toBeUndefined();
    expect(store[server.name]?.tokens).toBeDefined();
    expect(store[server.name]?.authRequirement).toBe('oauth');
  });

  it('invalidateCredentials("all") clears tokens and client registration but preserves auth requirement', async () => {
    await writeCredentials(configPath, server.name, {
      clientRegistration: { client_id: 'reg-id' },
      tokens: { access_token: 'at-123', token_type: 'Bearer' },
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.invalidateCredentials('all');

    expect(await mgr.tokens()).toBeUndefined();
    expect(await mgr.clientInformation()).toBeUndefined();

    const store = await readCredentials(configPath);
    expect(store[server.name]).toEqual({
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });
  });

  it('invalidateCredentials("verifier") clears the in-memory code verifier only', async () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.saveCodeVerifier('pkce-verifier');
    expect(await mgr.codeVerifier()).toBe('pkce-verifier');

    await mgr.invalidateCredentials('verifier');

    // The in-memory verifier is gone.
    await expect(mgr.codeVerifier()).rejects.toThrow('No code verifier saved');
    // credentials.json was never created (verifier is in-memory only).
    const store = await readCredentials(configPath);
    expect(store[server.name]).toBeUndefined();
  });

  it('invalidateCredentials("tokens") is a no-op when no credentials are stored', async () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    await expect(mgr.invalidateCredentials('tokens')).resolves.toBeUndefined();
    expect(await readCredentials(configPath)).toEqual({});
  });

  it('invalidateCredentials("tokens") does not clear tokens another process refreshed', async () => {
    // This manager's refresh attempt was based on the expired tokens
    // below; while it was failing with invalid_grant, another router
    // instance refreshed the same entry successfully.
    await writeCredentials(configPath, server.name, {
      clientRegistration: { client_id: 'reg-id' },
      tokens: {
        access_token: 'stale-at',
        refresh_token: 'stale-rt',
        token_type: 'Bearer',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    await writeCredentials(configPath, server.name, {
      clientRegistration: { client_id: 'reg-id' },
      tokens: {
        access_token: 'fresh-at',
        refresh_token: 'fresh-rt',
        token_type: 'Bearer',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
      authRequirement: 'oauth',
      checkedAt: new Date().toISOString(),
    });

    // The SDK calls invalidateCredentials('tokens') after an
    // InvalidGrantError. The fresh tokens belong to the instance that
    // won the refresh and must survive.
    await mgr.invalidateCredentials('tokens');

    const store = await readCredentials(configPath);
    expect(store[server.name]?.tokens?.access_token).toBe('fresh-at');
    expect(store[server.name]?.tokens?.refresh_token).toBe('fresh-rt');
  });

  it('invalidateCredentials("tokens") still clears stale tokens after a failed refresh', async () => {
    await writeCredentials(configPath, server.name, {
      tokens: {
        access_token: 'stale-at',
        refresh_token: 'stale-rt',
        token_type: 'Bearer',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
      authRequirement: 'oauth',
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.invalidateCredentials('tokens');

    const store = await readCredentials(configPath);
    expect(store[server.name]?.tokens).toBeUndefined();
    expect(store[server.name]?.authRequirement).toBe('oauth');
  });

  it('redirectToAuthorization throws GuidedAuthError with the server name', async () => {
    // The router is a headless stdio server with no callback server
    // running; opening a browser would point at a non-existent
    // callback URL. It must fail fast with a tagged auth error so
    // callers can discriminate auth failures from other errors.
    const mgr = new OAuthCredentialManager(configPath, server);
    await expect(
      mgr.redirectToAuthorization(new URL('https://as.example.com/authorize')),
    ).rejects.toThrow(GuidedAuthError);
  });

  it('redirectToAuthorization includes the server name in the error message', async () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    try {
      await mgr.redirectToAuthorization(new URL('https://as.example.com/authorize'));
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GuidedAuthError);
      expect((err as GuidedAuthError).serverName).toBe('test-server');
      expect((err as Error).message).toContain('test-server');
    }
  });

  it('uses oauth overrides when provided', () => {
    const oauthServer: DownstreamServerConfig = {
      ...server,
      oauth: { clientId: 'override-id', clientSecret: 'override-secret', scope: 'admin' },
    };
    const mgr = new OAuthCredentialManager(configPath, oauthServer);
    expect(mgr.hasStaticClient()).toBe(true);
  });

  it('saveTokens records the server URL binding', async () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.saveTokens({ access_token: 'at-123', token_type: 'Bearer' });

    const store = await readCredentials(configPath);
    expect(store[server.name]?.serverUrl).toBe('https://example.com/mcp');
  });

  it('saveClientInformation records the server URL binding', async () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.saveClientInformation({ client_id: 'client-1' });

    const store = await readCredentials(configPath);
    expect(store[server.name]?.serverUrl).toBe('https://example.com/mcp');
  });

  it('records the authorization server issuer when it is known', async () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    mgr.setIssuer('https://auth.example.com/');
    await mgr.saveTokens({ access_token: 'at-123', token_type: 'Bearer' });

    const store = await readCredentials(configPath);
    expect(store[server.name]?.issuer).toBe('https://auth.example.com/');
  });

  it('ignores credentials bound to a different server URL', async () => {
    await writeCredentials(configPath, server.name, {
      serverUrl: 'https://different.example.org/mcp',
      clientRegistration: { client_id: 'old-client' },
      tokens: { access_token: 'old-at', token_type: 'Bearer' },
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    expect(await mgr.clientInformation()).toBeUndefined();
    expect(await mgr.tokens()).toBeUndefined();
  });

  it('ignores credentials from a different issuer once the issuer is known', async () => {
    await writeCredentials(configPath, server.name, {
      serverUrl: 'https://example.com/mcp',
      issuer: 'https://old-auth.example.com/',
      clientRegistration: { client_id: 'old-client' },
      tokens: { access_token: 'old-at', token_type: 'Bearer' },
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    mgr.setIssuer('https://auth.example.com/');
    expect(await mgr.clientInformation()).toBeUndefined();
    expect(await mgr.tokens()).toBeUndefined();
  });

  it('adopts legacy credentials without a serverUrl and binds them on save', async () => {
    await writeCredentials(configPath, server.name, {
      clientRegistration: { client_id: 'legacy-client' },
      tokens: { access_token: 'legacy-at', token_type: 'Bearer' },
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    expect((await mgr.tokens())?.access_token).toBe('legacy-at');

    await mgr.saveTokens({ access_token: 'new-at', token_type: 'Bearer' });
    const store = await readCredentials(configPath);
    expect(store[server.name]?.serverUrl).toBe('https://example.com/mcp');
    // The adopted registration survives the token write.
    expect(store[server.name]?.clientRegistration).toEqual({ client_id: 'legacy-client' });
    expect(store[server.name]?.tokens?.access_token).toBe('new-at');
  });

  it('replaces credentials bound to a different URL instead of preserving them', async () => {
    await writeCredentials(configPath, server.name, {
      serverUrl: 'https://different.example.org/mcp',
      clientRegistration: { client_id: 'old-client' },
      tokens: { access_token: 'old-at', token_type: 'Bearer' },
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.saveClientInformation({ client_id: 'fresh-client' });

    const store = await readCredentials(configPath);
    expect(store[server.name]?.serverUrl).toBe('https://example.com/mcp');
    expect(store[server.name]?.clientRegistration).toEqual({ client_id: 'fresh-client' });
    // The old server's tokens are not carried over.
    expect(store[server.name]?.tokens).toBeUndefined();
  });

  it('does not inherit a stale binding from a probe-only entry', async () => {
    // A server probed at an older URL but never logged in: the probe
    // entry carries no credentials, so its recorded URL must not be
    // stamped onto the fresh registration.
    await writeCredentials(configPath, server.name, {
      serverUrl: 'https://old.example.com/mcp',
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.saveClientInformation({ client_id: 'fresh-client' });

    const store = await readCredentials(configPath);
    expect(store[server.name]?.serverUrl).toBe('https://example.com/mcp');
    // The fresh registration must be readable immediately.
    expect(await mgr.clientInformation()).toEqual({ client_id: 'fresh-client' });
  });

  it('does not inherit a stale binding from a probe-only entry on token save', async () => {
    await writeCredentials(configPath, server.name, {
      serverUrl: 'https://old.example.com/mcp',
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.saveTokens({ access_token: 'fresh-at', token_type: 'Bearer' });

    const store = await readCredentials(configPath);
    expect(store[server.name]?.serverUrl).toBe('https://example.com/mcp');
    expect((await mgr.tokens())?.access_token).toBe('fresh-at');
  });

  it('invalidateCredentials preserves the server URL binding', async () => {
    await writeCredentials(configPath, server.name, {
      serverUrl: 'https://example.com/mcp',
      clientRegistration: { client_id: 'reg-id' },
      tokens: { access_token: 'at-123', token_type: 'Bearer' },
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.invalidateCredentials('tokens');

    const store = await readCredentials(configPath);
    expect(store[server.name]?.serverUrl).toBe('https://example.com/mcp');
    expect(store[server.name]?.clientRegistration).toEqual({ client_id: 'reg-id' });
  });

  it('clearTokens removes a mismatched entry entirely', async () => {
    // The entry belongs to another server URL: nothing in it is worth
    // preserving, so the whole entry is dropped (the next probe
    // refreshes the auth requirement for the current URL).
    await writeCredentials(configPath, server.name, {
      serverUrl: 'https://different.example.org/mcp',
      tokens: { access_token: 'old-at', token_type: 'Bearer' },
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.clearTokens();

    const store = await readCredentials(configPath);
    expect(store[server.name]).toBeUndefined();
  });
});
