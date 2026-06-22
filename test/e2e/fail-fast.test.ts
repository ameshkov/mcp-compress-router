import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnRouter, resolveFixtureCommand } from './helpers.js';

describe('MCP Compress Router — fail-fast startup', () => {
  it('exits non-zero when a downstream server is unreachable', async () => {
    const failTempDir = path.join(tmpdir(), `mcp-e2e-fail-${Date.now()}`);
    await fs.mkdir(failTempDir, { recursive: true });

    const config = {
      mcpServers: {
        dead: {
          type: 'stdio',
          command: '/nonexistent/command',
        },
      },
    };

    const configPath = path.join(failTempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    try {
      const { exitCode, stderr } = await spawnRouter(configPath, failTempDir);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('dead');

      // Verify structured error-level logging
      expect(stderr).toContain('"level":"error"');
      expect(stderr).toContain('"server":"dead"');

      // Should NOT contain debug messages (not verbose)
      expect(stderr).not.toContain('"level":"debug"');
    } finally {
      await fs.rm(failTempDir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when one of multiple servers is unreachable', async () => {
    const mixedTempDir = path.join(tmpdir(), `mcp-e2e-mixed-${Date.now()}`);
    await fs.mkdir(mixedTempDir, { recursive: true });

    const fixture = await resolveFixtureCommand();

    const config = {
      mcpServers: {
        alive: {
          type: 'stdio',
          command: fixture.command,
          args: fixture.args,
        },
        dead: {
          type: 'stdio',
          command: '/nonexistent/command',
        },
      },
    };

    const configPath = path.join(mixedTempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    try {
      const { exitCode, stderr } = await spawnRouter(configPath, mixedTempDir);

      // Must exit non-zero (fail fast)
      expect(exitCode).not.toBe(0);

      // Stderr must identify the failing server
      expect(stderr).toContain('dead');

      // Verify structured error-level logging
      expect(stderr).toContain('"level":"error"');
      expect(stderr).toContain('"server":"dead"');
    } finally {
      await fs.rm(mixedTempDir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when config has an unknown transport type', async () => {
    const failTempDir = path.join(tmpdir(), `mcp-e2e-unknown-type-${Date.now()}`);
    await fs.mkdir(failTempDir, { recursive: true });

    const config = {
      mcpServers: {
        test: {
          type: 'sse',
          url: 'https://example.com',
        },
      },
    };

    const configPath = path.join(failTempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    try {
      const { exitCode, stderr } = await spawnRouter(configPath, failTempDir);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('unsupported type');
    } finally {
      await fs.rm(failTempDir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when config has an unresolved ${VAR}', async () => {
    const failTempDir = path.join(tmpdir(), `mcp-e2e-unresolved-var-${Date.now()}`);
    await fs.mkdir(failTempDir, { recursive: true });

    const config = {
      mcpServers: {
        test: {
          type: 'stdio',
          command: '${DEFINITELY_NOT_SET_E2E_VAR_12345}',
        },
      },
    };

    const configPath = path.join(failTempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    try {
      const { exitCode, stderr } = await spawnRouter(configPath, failTempDir);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('DEFINITELY_NOT_SET_E2E_VAR_12345');
    } finally {
      await fs.rm(failTempDir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when config contains zero servers', async () => {
    const failTempDir = path.join(tmpdir(), `mcp-e2e-empty-${Date.now()}`);
    await fs.mkdir(failTempDir, { recursive: true });

    const config = { mcpServers: {} };

    const configPath = path.join(failTempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    try {
      const { exitCode, stderr } = await spawnRouter(configPath, failTempDir);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('no downstream MCP servers');
    } finally {
      await fs.rm(failTempDir, { recursive: true, force: true });
    }
  });
});
