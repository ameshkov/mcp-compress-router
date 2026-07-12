import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { OAuthCredentialManager } from './oauth.js';
import { readCredentials, writeCredentials } from '../cli/config-io.js';
import { Logger } from '../utils/index.js';
import type { DownstreamServerConfig } from '../utils/types.js';

// Hoisted mocks for the OAuth discovery and SDK refresh functions.
// `discoverAuth` and `refreshAuthorization` are replaced so the
// proactive-refresh logic can be exercised without real network I/O.
// `refreshAuthorization` is imported as a top-level static value in
// oauth.ts; vitest's hoisted mock intercepts it at the module
// registry level before any static import is evaluated.
const { discoverAuthMock, refreshAuthorizationMock } = vi.hoisted(() => ({
  discoverAuthMock: vi.fn(),
  refreshAuthorizationMock: vi.fn(),
}));

vi.mock('./oauth-discovery.js', () => ({
  discoverAuth: discoverAuthMock,
}));

vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  refreshAuthorization: refreshAuthorizationMock,
  // OAuthClientProvider is a TypeScript type-only import (erased at
  // runtime); other exports from this module are not consumed by
  // oauth.ts, so they are absent from this runtime mock without issue.
}));

/**
 * Fresh mock token response returned by `refreshAuthorization`. Has
 * a new refresh token and a one-hour TTL so `saveTokens` recomputes
 * a future `expires_at`.
 */
const FRESH_TOKENS = {
  access_token: 'fresh-at',
  refresh_token: 'fresh-rt',
  expires_in: 3600,
  token_type: 'Bearer',
} as const;

const AS_URL = new URL('https://as.example.com/');

const SERVER_METADATA = {
  issuer: 'https://as.example.com/',
  token_endpoint: 'https://as.example.com/token',
  authorization_endpoint: 'https://as.example.com/authorize',
};

const server: DownstreamServerConfig = {
  name: 'test-server',
  type: 'http',
  url: 'https://example.com/mcp',
};

describe('OAuthCredentialManager.refreshIfNeeded', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-refresh-'));
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
    refreshAuthorizationMock.mockResolvedValue(FRESH_TOKENS);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  /** Seeds stored tokens with the given absolute expiry. */
  async function seedTokens(expiresAtIso: string): Promise<void> {
    await writeCredentials(configPath, server.name, {
      clientRegistration: { client_id: 'reg-id' },
      tokens: {
        access_token: 'stale-at',
        token_type: 'Bearer',
        refresh_token: 'stale-rt',
        expires_at: expiresAtIso,
      },
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });
  }

  it('does nothing when no tokens are stored', async () => {
    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.refreshIfNeeded();
    expect(discoverAuthMock).not.toHaveBeenCalled();
    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
  });

  it('does nothing when tokens have no refresh_token', async () => {
    await writeCredentials(configPath, server.name, {
      tokens: {
        access_token: 'no-refresh-at',
        token_type: 'Bearer',
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.refreshIfNeeded();
    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
  });

  it('does nothing when tokens have no expires_at (legacy tokens)', async () => {
    await writeCredentials(configPath, server.name, {
      clientRegistration: { client_id: 'reg-id' },
      tokens: {
        access_token: 'legacy-at',
        token_type: 'Bearer',
        refresh_token: 'legacy-rt',
        // No expires_at: fall back to the SDK's reactive 401 path.
      },
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.refreshIfNeeded();
    expect(discoverAuthMock).not.toHaveBeenCalled();
    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
  });

  it('does nothing when the token is far from expiry', async () => {
    await seedTokens(new Date(Date.now() + 3600_000).toISOString());

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.refreshIfNeeded();
    expect(discoverAuthMock).not.toHaveBeenCalled();
    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
    // Access token unchanged.
    expect((await mgr.tokens())?.access_token).toBe('stale-at');
  });

  it('refreshes the token when it is already expired', async () => {
    await seedTokens(new Date(Date.now() - 1000).toISOString());

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.refreshIfNeeded();

    expect(discoverAuthMock).toHaveBeenCalledWith(new URL('https://example.com/mcp'));
    expect(refreshAuthorizationMock).toHaveBeenCalledWith(
      AS_URL,
      expect.objectContaining({ refreshToken: 'stale-rt' }),
    );

    // New tokens persisted with a fresh access token and a future
    // expiry derived from expires_in.
    const loaded = await mgr.tokens();
    expect(loaded?.access_token).toBe('fresh-at');
    const store = await readCredentials(configPath);
    expect(store[server.name]?.tokens?.refresh_token).toBe('fresh-rt');
    expect(store[server.name]?.tokens?.expires_at).toBeDefined();
    const expiresMs = Date.parse(store[server.name]!.tokens!.expires_at!);
    expect(expiresMs).toBeGreaterThan(Date.now());
  });

  it('refreshes the token when expiry is within the refresh buffer', async () => {
    // 30s in the future: inside the 60s proactive buffer.
    await seedTokens(new Date(Date.now() + 30_000).toISOString());

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.refreshIfNeeded();

    expect(refreshAuthorizationMock).toHaveBeenCalledTimes(1);
    expect((await mgr.tokens())?.access_token).toBe('fresh-at');
  });

  it('swallows refresh errors, logs them, and leaves stored tokens unchanged', async () => {
    await seedTokens(new Date(Date.now() - 1000).toISOString());
    refreshAuthorizationMock.mockRejectedValue(new Error('network down'));

    const mgr = new OAuthCredentialManager(configPath, server);
    const logger = new Logger('debug');
    const errorSpy = vi.spyOn(logger, 'error');

    // Best-effort: must not throw.
    await expect(mgr.refreshIfNeeded(logger)).resolves.toBeUndefined();

    // The failure was logged at error level so it is visible without
    // waiting for the SDK's reactive 401 path.
    expect(errorSpy).toHaveBeenCalledWith(
      'Proactive OAuth token refresh failed',
      expect.objectContaining({
        server: 'test-server',
        error: 'network down',
      }),
    );
    // Stored tokens are unchanged; the SDK's reactive 401 path is the
    // fallback for terminal failures.
    expect((await mgr.tokens())?.access_token).toBe('stale-at');
  });

  it('does not refresh when discovery yields no server metadata', async () => {
    await seedTokens(new Date(Date.now() - 1000).toISOString());
    discoverAuthMock.mockResolvedValue({
      serverMetadata: undefined,
      authorizationServerUrl: AS_URL,
    });

    const mgr = new OAuthCredentialManager(configPath, server);
    await mgr.refreshIfNeeded();

    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
    expect((await mgr.tokens())?.access_token).toBe('stale-at');
  });

  it('deduplicates concurrent refresh calls into a single token request', async () => {
    await seedTokens(new Date(Date.now() - 1000).toISOString());
    // Slow the refresh so concurrent callers overlap.
    refreshAuthorizationMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(FRESH_TOKENS), 50)),
    );

    const mgr = new OAuthCredentialManager(configPath, server);
    // Fire several concurrent refresh attempts.
    await Promise.all([mgr.refreshIfNeeded(), mgr.refreshIfNeeded(), mgr.refreshIfNeeded()]);

    // Only one token request reached the authorization server.
    expect(refreshAuthorizationMock).toHaveBeenCalledTimes(1);
    expect((await mgr.tokens())?.access_token).toBe('fresh-at');
  });
});
