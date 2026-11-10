import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleLogin } from './login-command.js';
import { OAUTH_LOOPBACK_URI, OAuthCredentialManager } from '../services/oauth.js';
import { readCredentials, writeCredentials } from './config-io.js';
import { buildLogoutCommand } from '../utils/index.js';
import { openBrowser } from '../utils/open-browser.js';
import { startDiscoveryServer } from '../../test/login-discovery-server.js';

vi.mock('../utils/open-browser.js', () => ({
  openBrowser: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Tests for the login token exchange discarding a dynamic client
 * registration the token endpoint rejects with `invalid_client`. A
 * provider can forget or revoke a registration without recording an
 * expiry, so the provider's rejection is the only authoritative signal.
 */
describe('handleLogin — rejected client registration recovery', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-login-recovery-test-'));
    configPath = path.join(tmpDir, 'mcp.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  /**
   * Writes a one-server config pointing at the discovery fixture.
   *
   * @param url - The fixture base URL.
   * @param oauth - Optional static OAuth client override.
   */
  async function writeConfig(
    url: string,
    oauth?: { clientId: string; clientSecret?: string },
  ): Promise<void> {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          test: {
            type: 'http',
            url: url + '/mcp',
            description: 'Discovery test server',
            ...(oauth ? { oauth } : {}),
          },
        },
      }),
    );
  }

  it('discards the stored registration when the token endpoint rejects it', async () => {
    const { server, url } = await startDiscoveryServer({
      tokenError: { error: 'invalid_client', error_description: 'Invalid client_id' },
    });

    // Complete the authorization round trip so login reaches the token
    // exchange, where the provider rejects the client.
    vi.mocked(openBrowser).mockImplementationOnce(async (authorizationUrl) => {
      await fetch(authorizationUrl);
    });

    try {
      await writeConfig(url);
      await writeCredentials(configPath, 'test', {
        clientRegistration: {
          client_id: 'revoked-client',
          client_secret: 'stored-secret',
          redirect_uris: [OAUTH_LOOPBACK_URI],
        },
      });
      await expect(handleLogin(configPath, 'test')).rejects.toThrow(
        'Server "test" rejected the stored OAuth client registration (invalid_client: Invalid client_id). Run "npx mcp-compress-router login test" again to register a new client.',
      );
    } finally {
      server.close();
    }

    // The dead registration must not be left on disk: the next login has
    // to register a new client instead of repeating the same failure.
    const stored = await readCredentials(configPath);
    expect(stored.test?.clientRegistration).toBeUndefined();
  }, 10_000);

  it('reports the cleanup failure and the logout-then-login commands when the discard fails', async () => {
    const { server, url } = await startDiscoveryServer({
      tokenError: { error: 'invalid_client', error_description: 'Invalid client_id' },
    });

    vi.mocked(openBrowser).mockImplementationOnce(async (authorizationUrl) => {
      await fetch(authorizationUrl);
    });
    // The discard fails deterministically, as when the credentials lock
    // cannot be created. Mocking the manager method keeps the test
    // independent of Unix file permissions.
    const discardSpy = vi
      .spyOn(OAuthCredentialManager.prototype, 'discardClientRegistration')
      .mockRejectedValueOnce(new Error('credentials.json.lock: permission denied'));

    try {
      await writeConfig(url);
      await writeCredentials(configPath, 'test', {
        clientRegistration: {
          client_id: 'revoked-client',
          client_secret: 'stored-secret',
          redirect_uris: [OAUTH_LOOPBACK_URI],
        },
      });

      const error: unknown = await handleLogin(configPath, 'test').catch((err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      const guided = error as Error;
      // The provider rejection remains the surfaced cause, and the
      // message names the failed cleanup instead of promising that a
      // plain rerun heals the retained registration.
      expect(guided.message).toContain(
        'Server "test" rejected the stored OAuth client registration (invalid_client: Invalid client_id).',
      );
      expect(guided.message).toContain('The rejected registration could not be removed: ');
      expect(guided.message).toContain('credentials.json.lock');
      expect(guided.message).toContain(
        `Run "${buildLogoutCommand('test')}" and then "npx mcp-compress-router login test" to register a new client.`,
      );
      expect(guided.cause).toBeInstanceOf(Error);
      expect((guided.cause as Error).message).toBe('Invalid client_id');
    } finally {
      discardSpy.mockRestore();
      server.close();
    }

    // The failed discard must leave the dead registration in place: only
    // `logout` can clear it before the next login.
    const stored = await readCredentials(configPath);
    expect(stored.test?.clientRegistration?.client_id).toBe('revoked-client');
  }, 10_000);

  it('names the configured client fields when the provider rejects a static client', async () => {
    const { server, url, registrations } = await startDiscoveryServer({
      tokenError: { error: 'invalid_client', error_description: 'Invalid client_id' },
    });

    vi.mocked(openBrowser).mockImplementationOnce(async (authorizationUrl) => {
      await fetch(authorizationUrl);
    });

    try {
      await writeConfig(url, { clientId: 'pre-registered-client-id' });
      await writeCredentials(configPath, 'test', {
        clientRegistration: {
          client_id: 'revoked-client',
          client_secret: 'stored-secret',
          redirect_uris: [OAUTH_LOOPBACK_URI],
        },
      });

      const error: unknown = await handleLogin(configPath, 'test').catch((err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      const guided = error as Error;
      expect(guided.message).toContain(
        'Server "test" rejected the configured OAuth client id (invalid_client: Invalid client_id).',
      );
      expect(guided.message).toContain(
        'Check "oauth.clientId" and "oauth.clientSecret" in mcp.json.',
      );
      expect(guided.cause).toBeInstanceOf(Error);
      expect((guided.cause as Error).message).toBe('Invalid client_id');
    } finally {
      server.close();
    }

    // A configured client bypasses dynamic client registration, so the
    // fixture saw no registration request, and the seeded dynamic
    // registration is not touched.
    expect(registrations).toHaveLength(0);
    const stored = await readCredentials(configPath);
    expect(stored.test?.clientRegistration).toEqual({
      client_id: 'revoked-client',
      client_secret: 'stored-secret',
      redirect_uris: [OAUTH_LOOPBACK_URI],
    });
  }, 10_000);

  it('guides the user to login when the stored registration disappears during authorization', async () => {
    const { server, url } = await startDiscoveryServer();

    // Simulate another process running `logout` during the interactive
    // wait: remove the shared credentials entry right before the browser
    // follows the authorization redirect to the loopback callback.
    vi.mocked(openBrowser).mockImplementationOnce(async (authorizationUrl) => {
      await fs.rm(path.join(tmpDir, 'credentials.json'));
      await fetch(authorizationUrl);
    });

    try {
      await writeConfig(url);
      await writeCredentials(configPath, 'test', {
        clientRegistration: {
          client_id: 'revoked-client',
          client_secret: 'stored-secret',
          redirect_uris: [OAUTH_LOOPBACK_URI],
        },
      });

      const error: unknown = await handleLogin(configPath, 'test').catch((err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      const guided = error as Error;
      expect(guided.message).toBe(
        'Server "test" has no stored OAuth client registration to finish the login. Run "npx mcp-compress-router login test" to register a new client and authorize this server.',
      );
      expect(guided.message).not.toContain('could not be removed');
      expect(guided.message).not.toContain('logout');
      expect(guided.message).not.toContain('Cannot read properties');
      expect(guided.cause).toBeUndefined();
    } finally {
      server.close();
    }
  }, 10_000);
});
