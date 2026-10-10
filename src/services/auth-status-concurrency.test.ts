import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { persistAuthRequirements } from './auth-status.js';
import { readCredentials, writeCredentials } from '../cli/config-io.js';
import { Logger, resolveServerTimeouts } from '../utils/index.js';
import type { DownstreamServerConfig } from '../utils/types.js';

// The probe is mocked so the test can hold it open while another writer
// (a concurrent router instance) refreshes the stored tokens.
const { discoverAuthMock } = vi.hoisted(() => ({ discoverAuthMock: vi.fn() }));

vi.mock('./oauth-discovery.js', () => ({
  discoverAuth: discoverAuthMock,
}));

describe('persistAuthRequirements concurrent refresh', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-auth-status-race-'));
    configPath = path.join(tmpDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }));
    discoverAuthMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const server: DownstreamServerConfig = {
    name: 'auth-fixture',
    description: 'OAuth auth fixture server',
    type: 'http',
    url: 'https://example.com/mcp',
    timeout: resolveServerTimeouts(),
  };

  it('does not clobber tokens refreshed while the probe was in flight', async () => {
    await writeCredentials(configPath, server.name, {
      tokens: {
        access_token: 'stale-at',
        refresh_token: 'stale-rt',
        token_type: 'Bearer',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
      authRequirement: 'oauth',
    });

    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    discoverAuthMock.mockImplementation(async () => {
      probeStarted();
      await probeGate;
      return {
        serverMetadata: {
          issuer: 'https://as.example.com/',
          token_endpoint: 'https://as.example.com/token',
          authorization_endpoint: 'https://as.example.com/authorize',
        },
        authorizationServerUrl: new URL('https://as.example.com/'),
      };
    });

    const pending = persistAuthRequirements(configPath, [server], new Logger('error'));

    // The store snapshot has been taken and the probe is running: now
    // another process completes a token refresh.
    await started;
    await writeCredentials(configPath, server.name, {
      tokens: {
        access_token: 'fresh-at',
        refresh_token: 'fresh-rt',
        token_type: 'Bearer',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
      authRequirement: 'oauth',
    });

    releaseProbe();
    await pending;

    // The auth-requirement update must merge into the fresh entry
    // instead of restoring the stale snapshot it started from.
    const store = await readCredentials(configPath);
    expect(store[server.name]?.tokens?.access_token).toBe('fresh-at');
    expect(store[server.name]?.tokens?.refresh_token).toBe('fresh-rt');
    expect(store[server.name]?.authRequirement).toBe('oauth');
  });
});
