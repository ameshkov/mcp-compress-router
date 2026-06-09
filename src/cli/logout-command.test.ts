import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleLogout } from './logout-command.js';
import { writeCredentials } from './config-io.js';
import { readCredentials } from './config-io.js';

describe('handleLogout', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-logout-test-'));
    configPath = path.join(tmpDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { github: { type: 'http', url: 'https://api.github.com/mcp' } },
      }),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it('throws guided error when server name not in config', async () => {
    await expect(handleLogout(configPath, 'unknown')).rejects.toThrow(
      /Server "unknown" not found.*Available servers: github/,
    );
  });

  it('removes stored credentials for a server', async () => {
    await writeCredentials(configPath, 'github', {
      tokens: { access_token: 'at-123', token_type: 'Bearer' },
    });
    const result = await handleLogout(configPath, 'github');
    expect(result).toContain('Removed credentials');
    const creds = await readCredentials(configPath);
    expect(creds.github).toBeUndefined();
  });

  it('succeeds even when no credentials are stored', async () => {
    const result = await handleLogout(configPath, 'github');
    expect(result).toContain('No credentials');
  });
});
