import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { OAuthCredentialManager, OAUTH_CALLBACK_PATH } from './oauth.js';
import { readCredentials, writeCredentials } from '../cli/config-io.js';
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
    type: 'http',
    url: 'https://example.com/mcp',
  };

  it('redirectUrl returns localhost URL with actual port after setActualPort', () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    mgr.setActualPort(54321);
    expect(mgr.redirectUrl).toBe(`http://localhost:54321${OAUTH_CALLBACK_PATH}`);
  });

  it('redirectUrl returns fallback port 0 before setActualPort is called', () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    expect(mgr.redirectUrl).toBe(`http://localhost:0${OAUTH_CALLBACK_PATH}`);
  });

  it('clientMetadata returns correct metadata with actual port', () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    mgr.setActualPort(54321);
    expect(mgr.clientMetadata.client_name).toBe('mcp-compress-router');
    expect(mgr.clientMetadata.redirect_uris).toEqual([
      `http://localhost:54321${OAUTH_CALLBACK_PATH}`,
    ]);
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

  it('uses oauth overrides when provided', () => {
    const oauthServer: DownstreamServerConfig = {
      ...server,
      oauth: { clientId: 'override-id', clientSecret: 'override-secret', scope: 'admin' },
    };
    const mgr = new OAuthCredentialManager(configPath, oauthServer);
    expect(mgr.hasStaticClient()).toBe(true);
  });
});
