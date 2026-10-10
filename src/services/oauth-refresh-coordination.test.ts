import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  AUTH_FAILURE_COOLDOWN_JITTER,
  AUTH_FAILURE_COOLDOWN_MS,
  OAuthCredentialManager,
} from './oauth.js';
import { readCredentials, writeCredentials } from '../cli/config-io.js';
import { resolveServerTimeouts } from '../utils/index.js';
import type { DownstreamServerConfig } from '../utils/types.js';

// Hoisted mocks for the OAuth discovery and SDK refresh functions, so
// the auth-failure backoff can be exercised without real network I/O.
// `refreshAuthorization` is imported as a top-level static value in
// oauth.ts; vitest's hoisted mock intercepts it at the module registry
// level before any static import is evaluated. The rest of the SDK auth
// module stays real, including `selectResourceURL` (which oauth.ts also
// imports), so the resource indicator a refresh carries is derived by
// the same code the SDK's auth() flow uses.
const { discoverAuthMock, refreshAuthorizationMock } = vi.hoisted(() => ({
  discoverAuthMock: vi.fn(),
  refreshAuthorizationMock: vi.fn(),
}));

vi.mock('./oauth-discovery.js', () => ({
  discoverAuth: discoverAuthMock,
}));

vi.mock('@modelcontextprotocol/sdk/client/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/client/auth.js')>();
  return {
    ...actual,
    refreshAuthorization: refreshAuthorizationMock,
  };
});

const AS_URL = new URL('https://as.example.com/');

const SERVER_METADATA = {
  issuer: 'https://as.example.com/',
  token_endpoint: 'https://as.example.com/token',
  authorization_endpoint: 'https://as.example.com/authorize',
};

const server: DownstreamServerConfig = {
  name: 'test-server',
  description: 'Test OAuth server',
  type: 'http',
  url: 'https://example.com/mcp',
  timeout: resolveServerTimeouts(),
};

/** Absolute expiry of the seeded stale access token (in the past). */
const STALE_EXPIRES_AT = '2026-06-22T11:00:00Z';

/** Fresh token response the mocked token request resolves with. */
const FRESH_TOKENS = {
  access_token: 'fresh-at',
  refresh_token: 'fresh-rt',
  expires_in: 3600,
  token_type: 'Bearer',
} as const;

describe('OAuthCredentialManager refresh coordination', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-coordination-'));
    configPath = path.join(tmpDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }));

    discoverAuthMock.mockReset();
    refreshAuthorizationMock.mockReset();
    // Sensible defaults so individual tests only override what they
    // assert against.
    discoverAuthMock.mockResolvedValue({
      serverMetadata: SERVER_METADATA,
      authorizationServerUrl: AS_URL,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(tmpDir, { recursive: true });
  });

  /**
   * Seeds an already-expired token entry for the test server, with a
   * refresh token and client registration so proactive refresh could
   * attempt a token request.
   */
  async function seedStaleTokens(): Promise<void> {
    await writeCredentials(configPath, server.name, {
      clientRegistration: { client_id: 'reg-id' },
      tokens: {
        access_token: 'stale-at',
        token_type: 'Bearer',
        refresh_token: 'stale-rt',
        expires_in: 3600,
        scope: 'read',
        expires_at: STALE_EXPIRES_AT,
      },
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });
  }

  it('returns the access token without a refresh token while the auth-failure backoff is active', async () => {
    await seedStaleTokens();
    const mgr = new OAuthCredentialManager(configPath, server);

    mgr.noteAuthFailure();

    const tokens = await mgr.tokens();
    expect(tokens?.access_token).toBe('stale-at');
    expect(tokens).not.toHaveProperty('refresh_token');
    // Every other stored field is preserved untouched.
    expect(tokens).toEqual({
      access_token: 'stale-at',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'read',
      expires_at: STALE_EXPIRES_AT,
    });
  });

  it('clears the backoff on noteAuthSuccess', async () => {
    await seedStaleTokens();
    const mgr = new OAuthCredentialManager(configPath, server);

    mgr.noteAuthFailure();
    mgr.noteAuthSuccess();

    expect((await mgr.tokens())?.refresh_token).toBe('stale-rt');
  });

  it('expires the backoff within the jittered window bounds', async () => {
    await seedStaleTokens();
    vi.useFakeTimers();
    const mgr = new OAuthCredentialManager(configPath, server);

    const start = Date.now();
    mgr.noteAuthFailure();

    // The jittered deadline is never earlier than the low end of the
    // window, so the backoff must still be active one millisecond
    // before it.
    vi.setSystemTime(start + AUTH_FAILURE_COOLDOWN_MS * (1 - AUTH_FAILURE_COOLDOWN_JITTER) - 1);
    expect((await mgr.tokens())?.refresh_token).toBeUndefined();

    // The jittered deadline is always earlier than the high end of the
    // window, so the backoff must have elapsed one millisecond after it.
    vi.setSystemTime(start + AUTH_FAILURE_COOLDOWN_MS * (1 + AUTH_FAILURE_COOLDOWN_JITTER) + 1);
    expect((await mgr.tokens())?.refresh_token).toBe('stale-rt');
  });

  it('skips proactive refresh while the backoff is active', async () => {
    await seedStaleTokens();
    const mgr = new OAuthCredentialManager(configPath, server);

    mgr.noteAuthFailure();
    await mgr.refreshIfNeeded();

    // The expired stored token would normally trigger a coordinated
    // refresh; during the backoff neither discovery nor a token request
    // may run.
    expect(discoverAuthMock).not.toHaveBeenCalled();
    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
  });

  it('adopts a token another process stored without issuing a token request', async () => {
    await seedStaleTokens();
    const mgr = new OAuthCredentialManager(configPath, server);

    // The stored token differs from the one the rejected request
    // carried: another process refreshed it while that request was in
    // flight, so it is adopted instead of triggering a refresh.
    const tokens = await mgr.refreshAfterUnauthorized('used-at');

    expect(tokens?.access_token).toBe('stale-at');
    expect(discoverAuthMock).not.toHaveBeenCalled();
    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
  });

  it('refreshes exactly once when the stored token is unchanged and returns the new tokens', async () => {
    await seedStaleTokens();
    refreshAuthorizationMock.mockResolvedValue(FRESH_TOKENS);
    const mgr = new OAuthCredentialManager(configPath, server);

    const tokens = await mgr.refreshAfterUnauthorized('stale-at');

    // Exactly one token request went out, carrying the stored refresh
    // token that the rejected access token was paired with.
    expect(refreshAuthorizationMock).toHaveBeenCalledTimes(1);
    expect(refreshAuthorizationMock).toHaveBeenCalledWith(
      AS_URL,
      expect.objectContaining({ refreshToken: 'stale-rt' }),
    );
    // The caller and the credentials file both see the fresh token.
    expect(tokens?.access_token).toBe('fresh-at');
    expect((await mgr.tokens())?.access_token).toBe('fresh-at');
  });

  it('returns undefined when no refresh token is stored', async () => {
    await writeCredentials(configPath, server.name, {
      clientRegistration: { client_id: 'reg-id' },
      tokens: {
        access_token: 'stale-at',
        token_type: 'Bearer',
        expires_at: STALE_EXPIRES_AT,
      },
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });
    const mgr = new OAuthCredentialManager(configPath, server);

    await expect(mgr.refreshAfterUnauthorized('stale-at')).resolves.toBeUndefined();

    expect(discoverAuthMock).not.toHaveBeenCalled();
    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
  });

  it('returns undefined while the auth-failure backoff is active', async () => {
    await seedStaleTokens();
    const mgr = new OAuthCredentialManager(configPath, server);

    mgr.noteAuthFailure();

    // The stored token is still the rejected one, but a recent 401
    // already survived an adopted or refreshed token: another refresh
    // would only burn a token request.
    await expect(mgr.refreshAfterUnauthorized('stale-at')).resolves.toBeUndefined();

    expect(discoverAuthMock).not.toHaveBeenCalled();
    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
  });

  it('shares one in-flight attempt across concurrent callers', async () => {
    await seedStaleTokens();
    // Hold the first attempt open so the second caller is guaranteed to
    // arrive while it is still in flight, then fail it. Both callers
    // must observe the shared failure, and the loser must not start a
    // second token request once the cross-process lock is released.
    let rejectFirstRequest!: (err: Error) => void;
    let notifyRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      notifyRequestStarted = resolve;
    });
    refreshAuthorizationMock
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirstRequest = reject;
            notifyRequestStarted();
          }),
      )
      .mockImplementation(async () => {
        throw new Error('token endpoint down');
      });
    const mgr = new OAuthCredentialManager(configPath, server);

    const first = mgr.refreshAfterUnauthorized('stale-at');
    await requestStarted;
    const second = mgr.refreshAfterUnauthorized('stale-at');
    rejectFirstRequest(new Error('token endpoint down'));

    await expect(first).rejects.toThrow('token endpoint down');
    await expect(second).rejects.toThrow('token endpoint down');
    expect(refreshAuthorizationMock).toHaveBeenCalledTimes(1);
  });

  it('starts a new attempt after the previous one settles', async () => {
    await seedStaleTokens();
    refreshAuthorizationMock.mockResolvedValueOnce(FRESH_TOKENS).mockResolvedValueOnce({
      access_token: 'fresh-at-2',
      refresh_token: 'fresh-rt-2',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    const mgr = new OAuthCredentialManager(configPath, server);

    const first = await mgr.refreshAfterUnauthorized('stale-at');
    expect(first?.access_token).toBe('fresh-at');

    // The next 401 carries the token the first attempt stored: the
    // settled attempt's slot must be released so a new token request
    // runs instead of the first result being replayed.
    const second = await mgr.refreshAfterUnauthorized('fresh-at');

    expect(second?.access_token).toBe('fresh-at-2');
    expect(refreshAuthorizationMock).toHaveBeenCalledTimes(2);
  });

  it('propagates a failed coordinated refresh when no token was adopted', async () => {
    await seedStaleTokens();
    refreshAuthorizationMock.mockRejectedValue(new Error('network down'));
    const mgr = new OAuthCredentialManager(configPath, server);

    // The failure-path re-read finds only the rejected token still
    // stored, so the original error propagates to the caller.
    await expect(mgr.refreshAfterUnauthorized('stale-at')).rejects.toThrow('network down');

    // The failed attempt must not touch the stored tokens: the caller
    // reports the failure and the next attempt can still refresh.
    const store = await readCredentials(configPath);
    expect(store[server.name]?.tokens?.access_token).toBe('stale-at');
    expect(store[server.name]?.tokens?.refresh_token).toBe('stale-rt');
  });

  it('adopts a concurrently stored token when the coordinated refresh fails', async () => {
    await seedStaleTokens();
    refreshAuthorizationMock.mockImplementation(async () => {
      // While this refresh was in flight, another router instance
      // refreshed the same rotating refresh token and stored its result.
      await writeCredentials(configPath, server.name, {
        clientRegistration: { client_id: 'reg-id' },
        tokens: {
          access_token: 'fresh-at',
          refresh_token: 'fresh-rt',
          token_type: 'Bearer',
          expires_in: 3600,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        authRequirement: 'oauth',
        checkedAt: new Date().toISOString(),
      });
      // This instance then fails (network error, lock timeout, or a
      // transient Protected Resource Metadata failure).
      throw new Error('network down');
    });
    const mgr = new OAuthCredentialManager(configPath, server);

    // The failure-path re-read finds the winner, so the failure is not
    // surfaced: the caller can retry the request with the winner token.
    const tokens = await mgr.refreshAfterUnauthorized('stale-at');

    expect(tokens?.access_token).toBe('fresh-at');
    expect(tokens?.refresh_token).toBe('fresh-rt');
    // Adoption is not an auth failure: the backoff stays off and the
    // refresh token remains available to the SDK.
    expect((await mgr.tokens())?.refresh_token).toBe('fresh-rt');
  });

  it('fails the refresh when Protected Resource Metadata discovery failed transiently', async () => {
    await seedStaleTokens();
    discoverAuthMock.mockResolvedValue({
      serverMetadata: SERVER_METADATA,
      authorizationServerUrl: AS_URL,
      resourceMetadataDiscoveryFailed: true,
    });
    const mgr = new OAuthCredentialManager(configPath, server);

    // Refreshing without the RFC 8707 resource indicator would issue an
    // unbound token, so the refresh fails instead.
    await expect(mgr.refreshAfterUnauthorized('stale-at')).rejects.toThrow(
      /Protected Resource Metadata/,
    );

    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
    const store = await readCredentials(configPath);
    expect(store[server.name]?.tokens?.access_token).toBe('stale-at');
    expect(store[server.name]?.tokens?.refresh_token).toBe('stale-rt');
  });

  it('adopts the winner when the refresh loses an invalid_grant race', async () => {
    await seedStaleTokens();
    refreshAuthorizationMock.mockImplementation(async () => {
      // While this refresh was in flight, another router instance
      // refreshed the same rotating refresh token and stored its result.
      await writeCredentials(configPath, server.name, {
        clientRegistration: { client_id: 'reg-id' },
        tokens: {
          access_token: 'fresh-at',
          refresh_token: 'fresh-rt',
          token_type: 'Bearer',
          expires_in: 3600,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        authRequirement: 'oauth',
        checkedAt: new Date().toISOString(),
      });
      // This instance lost the race and the provider rejected the
      // now-consumed refresh token.
      throw new InvalidGrantError('invalid grant');
    });
    const mgr = new OAuthCredentialManager(configPath, server);

    const tokens = await mgr.refreshAfterUnauthorized('stale-at');

    // The failure-path re-read finds the winner and adopts it instead
    // of surfacing the losing invalid_grant.
    expect(tokens?.access_token).toBe('fresh-at');
    expect(tokens?.refresh_token).toBe('fresh-rt');

    // The SDK's auth() reacts to InvalidGrantError by invalidating
    // stored tokens; the winner's fresh tokens must survive.
    await mgr.invalidateCredentials('tokens');

    const store = await readCredentials(configPath);
    expect(store[server.name]?.tokens?.access_token).toBe('fresh-at');
    expect(store[server.name]?.tokens?.refresh_token).toBe('fresh-rt');
  });
});
