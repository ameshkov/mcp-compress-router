import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareClaudeRun } from './claude.js';
import { createTestContext } from './test-support.js';

describe('Claude Code benchmark config', () => {
  it('maps an API key, base URL, and models onto a hermetic run', async () => {
    const { context, paths, cleanup } = await createTestContext('claude', 'direct', {
      BENCH_CLAUDE_API_KEY: 'sk-test',
      BENCH_CLAUDE_BASE_URL: 'https://gateway.example/v1',
      BENCH_CLAUDE_MODEL: 'claude-bench',
      BENCH_CLAUDE_SMALL_MODEL: 'claude-bench-small',
    });
    try {
      const prepared = await prepareClaudeRun(context);
      expect(prepared.command).toBe('claude');
      expect(prepared.args).toContain('-p');
      expect(prepared.args).toContain('--strict-mcp-config');
      expect(prepared.args).toContain('--dangerously-skip-permissions');
      expect(prepared.env.ANTHROPIC_API_KEY).toBe('sk-test');
      expect(prepared.env.ANTHROPIC_BASE_URL).toBe('https://gateway.example/v1');
      expect(prepared.env.ANTHROPIC_MODEL).toBe('claude-bench');
      expect(prepared.env.ANTHROPIC_SMALL_FAST_MODEL).toBe('claude-bench-small');
      expect(prepared.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-bench-small');
      expect(prepared.env.HOME).toBe(paths.homeDir);
      expect(prepared.env.CLAUDE_CONFIG_DIR).toBe(join(paths.homeDir, '.claude'));
      expect(prepared.env.IS_SANDBOX).toBe('1');
      expect(prepared.usageSource).toBe('claude');
      expect(prepared.usageEnv.CLAUDE_CONFIG_DIR).toBe(join(paths.homeDir, '.claude'));
      const document = JSON.parse(
        await readFile(join(paths.configDir, 'claude-mcp-config.json'), 'utf8'),
      ) as { mcpServers: Record<string, { type: string }> };
      expect(Object.keys(document.mcpServers)).toHaveLength(4);
      expect(document.mcpServers.notion?.type).toBe('stdio');
    } finally {
      await cleanup();
    }
  });

  it('passes the 1M-context model and window settings through to Claude Code', async () => {
    const { context, cleanup } = await createTestContext('claude', 'direct', {
      BENCH_CLAUDE_API_KEY: 'sk-test',
      BENCH_CLAUDE_MODEL: 'claude-opus-5[1m]',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
    });
    try {
      const prepared = await prepareClaudeRun(context);
      expect(prepared.env.ANTHROPIC_MODEL).toBe('claude-opus-5[1m]');
      expect(prepared.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
      expect(prepared.model).toBe('claude-opus-5[1m]');
    } finally {
      await cleanup();
    }
  });

  it('forces tool search off for the no-tool-search measurement', async () => {
    const { context, cleanup } = await createTestContext('claude-no-tool-search', 'direct', {
      BENCH_CLAUDE_API_KEY: 'sk-test',
      BENCH_CLAUDE_MODEL: 'claude-bench',
      ENABLE_TOOL_SEARCH: 'auto',
    });
    try {
      const prepared = await prepareClaudeRun(context);
      expect(prepared.env.ENABLE_TOOL_SEARCH).toBe('false');
      expect(prepared.model).toBe('claude-bench');
      expect(prepared.usageSource).toBe('claude');
    } finally {
      await cleanup();
    }
  });

  it('leaves the caller tool search setting for the default measurement', async () => {
    const { context, cleanup } = await createTestContext('claude', 'direct', {
      BENCH_CLAUDE_API_KEY: 'sk-test',
      BENCH_CLAUDE_MODEL: 'claude-bench',
      ENABLE_TOOL_SEARCH: 'auto',
    });
    try {
      const prepared = await prepareClaudeRun(context);
      expect(prepared.env.ENABLE_TOOL_SEARCH).toBe('auto');
    } finally {
      await cleanup();
    }
  });

  it('uses the OAuth token and hides host credentials', async () => {
    const { context, cleanup } = await createTestContext('claude', 'router', {
      BENCH_CLAUDE_OAUTH_TOKEN: 'oauth-test',
      BENCH_CLAUDE_MODEL: 'claude-bench',
      ANTHROPIC_API_KEY: 'host-key',
      CLAUDE_CODE_USE_BEDROCK: '1',
    });
    try {
      const prepared = await prepareClaudeRun(context);
      expect(prepared.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-test');
      expect(prepared.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(prepared.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('fails fast without credentials or a model', async () => {
    const withoutCredentials = await createTestContext('claude', 'direct', {
      BENCH_CLAUDE_MODEL: 'claude-bench',
    });
    try {
      await expect(prepareClaudeRun(withoutCredentials.context)).rejects.toThrow(
        /BENCH_CLAUDE_API_KEY/,
      );
    } finally {
      await withoutCredentials.cleanup();
    }
    const withoutModel = await createTestContext('claude', 'direct', {
      BENCH_CLAUDE_API_KEY: 'sk-test',
    });
    try {
      await expect(prepareClaudeRun(withoutModel.context)).rejects.toThrow(/BENCH_CLAUDE_MODEL/);
    } finally {
      await withoutModel.cleanup();
    }
  });

  it('router mode exposes only mcp-compress-router', async () => {
    const { context, paths, cleanup } = await createTestContext('claude', 'router', {
      BENCH_CLAUDE_API_KEY: 'sk-test',
      BENCH_CLAUDE_MODEL: 'claude-bench',
    });
    try {
      await prepareClaudeRun(context);
      const document = JSON.parse(
        await readFile(join(paths.configDir, 'claude-mcp-config.json'), 'utf8'),
      ) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(document.mcpServers)).toEqual(['mcp-compress-router']);
    } finally {
      await cleanup();
    }
  });
});
