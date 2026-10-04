import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleLogin, type LoginOptions } from './login-command.js';
import { OAUTH_CALLBACK_PATH, OAUTH_LOOPBACK_URI } from '../services/oauth.js';
import { writeCredentials } from './config-io.js';
import { startDiscoveryServer } from '../../test/login-discovery-server.js';

vi.mock('../utils/open-browser.js', () => ({
  openBrowser: vi.fn().mockResolvedValue(undefined),
}));

describe('handleLogin — dynamic client registration identity', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-login-identity-test-'));
    configPath = path.join(tmpDir, 'mcp.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  /**
   * Writes a one-server config pointing at the discovery fixture, with
   * an optional oauth block.
   */
  async function writeConfig(url: string, oauth?: Record<string, unknown>): Promise<void> {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          figma: {
            type: 'http',
            url: url + '/mcp',
            description: 'DCR identity test server',
            ...(oauth ? { oauth } : {}),
          },
        },
      }),
    );
  }

  /**
   * Runs a login that reaches the callback wait (openBrowser is mocked),
   * proving discovery and registration completed, and lets the flow time
   * out. A timeout means the registration and authorization requests
   * were sent, which is all these tests inspect.
   */
  async function loginUntilCallbackTimeout(options?: LoginOptions): Promise<void> {
    process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS = '500';
    try {
      await expect(handleLogin(configPath, 'figma', options)).rejects.toThrow(/timed out/);
    } finally {
      delete process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS;
    }
  }

  it('sends the configured oauth.clientName and oauth.clientUri to dynamic client registration', async () => {
    const { server, url, registrations } = await startDiscoveryServer();

    try {
      await writeConfig(url, {
        clientName: 'My Approved Client',
        clientUri: 'https://example.com/app',
      });
      await loginUntilCallbackTimeout();
    } finally {
      server.close();
    }

    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.client_name).toBe('My Approved Client');
    expect(registrations[0]!.client_uri).toBe('https://example.com/app');
    expect(registrations[0]!.redirect_uris).toEqual([OAUTH_LOOPBACK_URI]);
  }, 10_000);

  it('sends --client-name / --client-uri overrides to DCR without persisting them', async () => {
    const { server, url, registrations } = await startDiscoveryServer();

    try {
      await writeConfig(url);
      await loginUntilCallbackTimeout({
        clientNameOverride: 'Flag Client',
        clientUriOverride: 'https://flags.example.com/app',
      });
    } finally {
      server.close();
    }

    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.client_name).toBe('Flag Client');
    expect(registrations[0]!.client_uri).toBe('https://flags.example.com/app');

    // The flags are transient: the config keeps no oauth block.
    const parsed = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(parsed.mcpServers.figma.oauth).toBeUndefined();
  }, 10_000);

  it('merges flag overrides with the configured oauth identity', async () => {
    const { server, url, registrations } = await startDiscoveryServer();

    try {
      await writeConfig(url, {
        clientName: 'Config Client',
        clientUri: 'https://config.example.com/app',
      });
      await loginUntilCallbackTimeout({ clientNameOverride: 'Flag Client' });
    } finally {
      server.close();
    }

    expect(registrations).toHaveLength(1);
    // The flag overrides only its own field; client_uri still comes
    // from the config.
    expect(registrations[0]!.client_name).toBe('Flag Client');
    expect(registrations[0]!.client_uri).toBe('https://config.example.com/app');
  }, 10_000);

  it('re-registers when the stored client_name differs from the configured override', async () => {
    const { server, url, registrations } = await startDiscoveryServer();

    try {
      await writeConfig(url, { clientName: 'New Client' });
      await writeCredentials(configPath, 'figma', {
        clientRegistration: {
          client_id: 'old-client',
          client_secret: 'old-secret',
          redirect_uris: [`http://127.0.0.1:54321${OAUTH_CALLBACK_PATH}`],
          client_name: 'Old Client',
        },
      });
      await loginUntilCallbackTimeout();
    } finally {
      server.close();
    }

    // The stored identity no longer matches, so the registration is
    // replaced with one carrying the configured name.
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.client_name).toBe('New Client');
  }, 10_000);

  it('re-registers when the stored client_name differs from a transient --client-name override', async () => {
    const { server, url, registrations } = await startDiscoveryServer();

    try {
      await writeConfig(url);
      await writeCredentials(configPath, 'figma', {
        clientRegistration: {
          client_id: 'old-client',
          client_secret: 'old-secret',
          redirect_uris: [`http://127.0.0.1:54321${OAUTH_CALLBACK_PATH}`],
          client_name: 'Old Client',
        },
      });
      await loginUntilCallbackTimeout({ clientNameOverride: 'Flag Client' });
    } finally {
      server.close();
    }

    // The transient flag feeds the same effective-server identity check
    // as a configured override, so the stored registration is replaced.
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.client_name).toBe('Flag Client');
  }, 10_000);

  it('re-registers when the stored client_uri differs from the configured override', async () => {
    const { server, url, registrations } = await startDiscoveryServer();

    try {
      await writeConfig(url, { clientUri: 'https://new.example.com/app' });
      await writeCredentials(configPath, 'figma', {
        clientRegistration: {
          client_id: 'old-client',
          client_secret: 'old-secret',
          redirect_uris: [`http://127.0.0.1:54321${OAUTH_CALLBACK_PATH}`],
          client_uri: 'https://old.example.com/app',
        },
      });
      await loginUntilCallbackTimeout();
    } finally {
      server.close();
    }

    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.client_uri).toBe('https://new.example.com/app');
  }, 10_000);

  it('reuses a stored registration whose identity matches the overrides', async () => {
    const { server, url, registrations } = await startDiscoveryServer();

    try {
      await writeConfig(url, {
        clientName: 'New Client',
        clientUri: 'https://example.com/app',
      });
      await writeCredentials(configPath, 'figma', {
        clientRegistration: {
          client_id: 'stored-client',
          client_secret: 'stored-secret',
          redirect_uris: [`http://127.0.0.1:54321${OAUTH_CALLBACK_PATH}`],
          client_name: 'New Client',
          client_uri: 'https://example.com/app',
        },
      });
      await loginUntilCallbackTimeout();
    } finally {
      server.close();
    }

    expect(registrations).toHaveLength(0);
  }, 10_000);

  it('reuses a stored registration without client_name when an override is configured', async () => {
    const { server, url, registrations } = await startDiscoveryServer();

    try {
      await writeConfig(url, { clientName: 'New Client' });
      // Legacy registration (or a provider that does not echo the
      // metadata): the stored entry carries no identity to compare, so
      // it stays reusable instead of churning on every login.
      await writeCredentials(configPath, 'figma', {
        clientRegistration: {
          client_id: 'legacy-client',
          client_secret: 'legacy-secret',
          redirect_uris: [`http://127.0.0.1:54321${OAUTH_CALLBACK_PATH}`],
        },
      });
      await loginUntilCallbackTimeout();
    } finally {
      server.close();
    }

    expect(registrations).toHaveLength(0);
  }, 10_000);

  it('reuses a stored registration with a different client_name when no override is configured', async () => {
    const { server, url, registrations } = await startDiscoveryServer();

    try {
      await writeConfig(url);
      await writeCredentials(configPath, 'figma', {
        clientRegistration: {
          client_id: 'stored-client',
          client_secret: 'stored-secret',
          redirect_uris: [`http://127.0.0.1:54321${OAUTH_CALLBACK_PATH}`],
          client_name: 'Something Else',
        },
      });
      await loginUntilCallbackTimeout();
    } finally {
      server.close();
    }

    // Without an override there is no identity to enforce: existing
    // registrations keep being reused exactly as before.
    expect(registrations).toHaveLength(0);
  }, 10_000);

  it('rejects an empty --client-name before any network activity', async () => {
    await writeConfig('http://127.0.0.1:1');
    await expect(handleLogin(configPath, 'figma', { clientNameOverride: '   ' })).rejects.toThrow(
      /--client-name must be a non-empty string/,
    );
  });

  it('rejects a non-absolute --client-uri before any network activity', async () => {
    await writeConfig('http://127.0.0.1:1');
    await expect(
      handleLogin(configPath, 'figma', { clientUriOverride: 'not-a-url' }),
    ).rejects.toThrow(/--client-uri must be an absolute http\(s\) URL/);
  });
});
