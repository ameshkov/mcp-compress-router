import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfigDir, resolveConfigPath, defaultConfigDir } from './config.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { tmpdir } from 'node:os';

describe('resolveConfigDir', () => {
  const originalHome = process.env.MCP_COMPRESS_ROUTER_HOME;

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.MCP_COMPRESS_ROUTER_HOME = originalHome;
    } else {
      delete process.env.MCP_COMPRESS_ROUTER_HOME;
    }
  });

  it('returns the MCP_COMPRESS_ROUTER_HOME path when env var is set', () => {
    process.env.MCP_COMPRESS_ROUTER_HOME = '/custom/home';
    expect(resolveConfigDir()).toBe('/custom/home');
  });

  it('returns the platform-specific default path when env var is not set', () => {
    delete process.env.MCP_COMPRESS_ROUTER_HOME;
    expect(resolveConfigDir()).toBe(
      defaultConfigDir(process.platform, os.homedir(), process.env.APPDATA),
    );
  });
});

describe('defaultConfigDir', () => {
  // Expected bases are asserted via path.join so the cases stay portable
  // across the host's path separator (POSIX vs win32).
  it.each<[string, NodeJS.Platform, string, string | undefined, string]>([
    ['win32 with APPDATA', 'win32', 'C:/u', 'C:/u/AppData/Roaming', 'C:/u/AppData/Roaming'],
    ['win32 without APPDATA', 'win32', 'C:/u', undefined, 'C:/u/AppData/Roaming'],
    ['macOS', 'darwin', '/Users/user', undefined, '/Users/user/Library/Application Support'],
    ['Linux', 'linux', '/home/user', undefined, '/home/user/.local/share'],
    ['other Unix', 'freebsd', '/home/user', undefined, '/home/user/.local/share'],
  ])('resolves the correct directory for %s', (_name, platform, home, appData, expectedBase) => {
    expect(defaultConfigDir(platform, home, appData)).toBe(
      path.join(expectedBase, 'mcp-compress-router'),
    );
  });
});

describe('resolveConfigPath', () => {
  const originalHome = process.env.MCP_COMPRESS_ROUTER_HOME;
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(
      tmpdir(),
      `config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    if (originalHome !== undefined) {
      process.env.MCP_COMPRESS_ROUTER_HOME = originalHome;
    } else {
      delete process.env.MCP_COMPRESS_ROUTER_HOME;
    }
  });

  it('returns the explicit path when provided', async () => {
    await expect(resolveConfigPath('/explicit/mcp.json')).resolves.toBe('/explicit/mcp.json');
  });

  it('returns the MCP_COMPRESS_ROUTER_HOME path when env var is set and neither file exists', async () => {
    process.env.MCP_COMPRESS_ROUTER_HOME = tempDir;
    await expect(resolveConfigPath(undefined)).resolves.toBe(path.join(tempDir, 'mcp.json'));
  });

  it('returns the default home path when no arg or env var', async () => {
    delete process.env.MCP_COMPRESS_ROUTER_HOME;
    const expected = path.join(
      defaultConfigDir(process.platform, os.homedir(), process.env.APPDATA),
      'mcp.json',
    );
    await expect(resolveConfigPath(undefined)).resolves.toBe(expected);
  });

  it('prefers mcp.jsonc when both mcp.jsonc and mcp.json exist in the directory', async () => {
    process.env.MCP_COMPRESS_ROUTER_HOME = tempDir;
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, 'mcp.json'), '{}');
    await fs.writeFile(path.join(tempDir, 'mcp.jsonc'), '{}');
    await expect(resolveConfigPath(undefined)).resolves.toBe(path.join(tempDir, 'mcp.jsonc'));
  });

  it('falls back to mcp.json when only mcp.json exists', async () => {
    process.env.MCP_COMPRESS_ROUTER_HOME = tempDir;
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, 'mcp.json'), '{}');
    await expect(resolveConfigPath(undefined)).resolves.toBe(path.join(tempDir, 'mcp.json'));
  });

  it('returns mcp.json when neither mcp.jsonc nor mcp.json exists', async () => {
    process.env.MCP_COMPRESS_ROUTER_HOME = tempDir;
    await fs.mkdir(tempDir, { recursive: true });
    await expect(resolveConfigPath(undefined)).resolves.toBe(path.join(tempDir, 'mcp.json'));
  });
});
