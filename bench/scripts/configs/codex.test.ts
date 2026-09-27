import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareCodexRun } from './codex.js';
import { createTestContext } from './test-support.js';

describe('Codex CLI benchmark config', () => {
  it('routes the default endpoint through an HTTP-only provider when no base URL is set', async () => {
    const { context, paths, cleanup } = await createTestContext('codex', 'direct', {
      BENCH_CODEX_API_KEY: 'sk-test',
      BENCH_CODEX_MODEL: 'gpt-bench',
      OPENAI_API_KEY: 'host-key',
      CODEX_ACCESS_TOKEN: 'host-token',
    });
    try {
      const prepared = await prepareCodexRun(context);
      const codexHome = join(paths.homeDir, '.codex');
      expect(prepared.command).toBe('codex');
      expect(prepared.env.CODEX_HOME).toBe(codexHome);
      expect(prepared.env.CODEX_SQLITE_HOME).toBe(codexHome);
      expect(prepared.env.OPENAI_API_KEY).toBeUndefined();
      expect(prepared.env.CODEX_ACCESS_TOKEN).toBeUndefined();
      expect(prepared.args).not.toContain('--ephemeral');
      expect(prepared.usageEnv.CODEX_HOME).toBe(codexHome);
      const config = await readFile(join(codexHome, 'config.toml'), 'utf8');
      expect(config).toContain('model = "gpt-bench"');
      expect(config).toContain('model_provider = "bench"');
      expect(config).toContain('base_url = "https://api.openai.com/v1"');
      expect(config).toContain('env_key = "BENCH_CODEX_API_KEY"');
      expect(config).toContain('supports_websockets = false');
      expect(config).toContain('[mcp_servers.notion]');
      expect(config).toContain('MOCK_MCP_LOG = ');
      expect(config).toContain('approval_policy = "never"');
    } finally {
      await cleanup();
    }
  });

  it('declares a custom responses provider for a base URL', async () => {
    const { context, paths, cleanup } = await createTestContext('codex', 'router', {
      BENCH_CODEX_API_KEY: 'sk-test',
      BENCH_CODEX_BASE_URL: 'https://gateway.example/v1',
      BENCH_CODEX_MODEL: 'gpt-bench',
    });
    try {
      const prepared = await prepareCodexRun(context);
      expect(prepared.env.OPENAI_API_KEY).toBeUndefined();
      const config = await readFile(join(paths.homeDir, '.codex', 'config.toml'), 'utf8');
      expect(config).toContain('model_provider = "bench"');
      expect(config).toContain('base_url = "https://gateway.example/v1"');
      expect(config).toContain('env_key = "BENCH_CODEX_API_KEY"');
      expect(config).toContain('wire_api = "responses"');
      expect(config).toContain('supports_websockets = false');
      expect(config).toContain('[mcp_servers.mcp-compress-router]');
      expect(config).not.toContain('[mcp_servers.notion]');
    } finally {
      await cleanup();
    }
  });

  it('rejects a missing API key or model', async () => {
    const withoutKey = await createTestContext('codex', 'direct', {
      BENCH_CODEX_MODEL: 'gpt-bench',
    });
    try {
      await expect(prepareCodexRun(withoutKey.context)).rejects.toThrow(/BENCH_CODEX_API_KEY/);
    } finally {
      await withoutKey.cleanup();
    }
  });
});
