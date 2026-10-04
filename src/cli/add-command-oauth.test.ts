import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { handleAdd } from './add-command.js';

const { discoverAuthMock, handleLoginMock } = vi.hoisted(() => ({
  discoverAuthMock: vi.fn<(url: URL) => Promise<{ serverMetadata?: Record<string, unknown> }>>(),
  handleLoginMock:
    vi.fn<
      (configPath: string, name: string, options?: { noBrowser?: boolean }) => Promise<string>
    >(),
}));

vi.mock('../services/oauth-discovery.js', () => ({
  discoverAuth: discoverAuthMock,
}));

vi.mock('./login-command.js', () => ({
  handleLogin: handleLoginMock,
}));

describe('handleAdd — OAuth client identity flags', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      tmpdir(),
      `cli-oauth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });
    // By default, servers do not advertise OAuth metadata, so `add`
    // skips the automatic login.
    discoverAuthMock.mockResolvedValue({ serverMetadata: undefined });
    handleLoginMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes oauth.clientName and oauth.clientUri for HTTP servers', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await handleAdd(configPath, {
      description: 'Figma MCP',
      name: 'figma',
      transport: 'http',
      commandOrUrl: 'https://mcp.figma.com/mcp',
      clientName: 'My Approved Client',
      clientUri: 'https://example.com/app',
      port: 19876,
    });

    const parsed = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(parsed.mcpServers.figma.oauth).toEqual({
      clientName: 'My Approved Client',
      clientUri: 'https://example.com/app',
      callbackPort: 19876,
    });
  });

  it('trims the client name before writing it to the config', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await handleAdd(configPath, {
      description: 'Figma MCP',
      name: 'figma',
      transport: 'http',
      commandOrUrl: 'https://mcp.figma.com/mcp',
      clientName: '  Padded Client  ',
    });

    const parsed = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(parsed.mcpServers.figma.oauth).toEqual({ clientName: 'Padded Client' });
  });

  it('throws when --client-name is passed for a stdio server', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await expect(
      handleAdd(configPath, {
        description: 'Test server',
        name: 'local',
        transport: 'stdio',
        commandOrUrl: 'npx',
        rest: ['-y', 'some-server'],
        clientName: 'My Client',
      }),
    ).rejects.toThrow(/--client-name is only supported for HTTP servers/);
  });

  it('throws when --client-uri is passed for a stdio server', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await expect(
      handleAdd(configPath, {
        description: 'Test server',
        name: 'local',
        transport: 'stdio',
        commandOrUrl: 'npx',
        rest: ['-y', 'some-server'],
        clientUri: 'https://example.com',
      }),
    ).rejects.toThrow(/--client-uri is only supported for HTTP servers/);
  });

  it('throws when --client-name is empty', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await expect(
      handleAdd(configPath, {
        description: 'Figma MCP',
        name: 'figma',
        transport: 'http',
        commandOrUrl: 'https://mcp.figma.com/mcp',
        clientName: '   ',
      }),
    ).rejects.toThrow(/--client-name must be a non-empty string/);
  });

  it('throws when --client-uri is not an absolute http(s) URL', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await expect(
      handleAdd(configPath, {
        description: 'Figma MCP',
        name: 'figma',
        transport: 'http',
        commandOrUrl: 'https://mcp.figma.com/mcp',
        clientUri: 'not-a-url',
      }),
    ).rejects.toThrow(/--client-uri must be an absolute http\(s\) URL/);
  });
});
