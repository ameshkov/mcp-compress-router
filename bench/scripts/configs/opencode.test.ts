import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareOpencodeRun, splitModelRef } from './opencode.js';
import { createTestContext } from './test-support.js';

/** Minimal shape of the generated opencode config used by the tests. */
interface OpencodeConfig {
  model: string;
  permission: string;
  provider: Record<
    string,
    { npm?: string; options?: Record<string, unknown>; models?: Record<string, unknown> }
  >;
  mcp: Record<string, unknown>;
}

/** Minimal shape of the generated native V2 config used by the tests. */
interface OpencodeV2Config {
  model: string;
  permission: string;
  provider?: unknown;
  providers?: Record<
    string,
    { package?: string; settings?: Record<string, unknown>; models?: Record<string, unknown> }
  >;
  mcp: { servers?: Record<string, { type?: string; disabled?: boolean; command?: string[] }> };
}

describe('OpenCode benchmark config', () => {
  it('overrides a built-in provider and writes a permissive hermetic config', async () => {
    const { context, paths, cleanup } = await createTestContext('opencode', 'direct', {
      BENCH_OPENCODE_API_KEY: 'sk-test',
      BENCH_OPENCODE_BASE_URL: 'https://gateway.example/v1',
      BENCH_OPENCODE_MODEL: 'anthropic/claude-bench',
      ANTHROPIC_API_KEY: 'host-key',
    });
    try {
      const prepared = await prepareOpencodeRun(context);
      const configPath = join(paths.homeDir, '.config', 'opencode', 'opencode.json');
      expect(prepared.command).toBe('opencode');
      expect(prepared.args).toContain('--format');
      expect(prepared.args).toContain('anthropic/claude-bench');
      expect(prepared.env.XDG_CONFIG_HOME).toBe(join(paths.homeDir, '.config'));
      expect(prepared.env.XDG_DATA_HOME).toBe(join(paths.homeDir, '.local', 'share'));
      expect(prepared.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(prepared.usageEnv.OPENCODE_DATA_DIR).toBe(
        join(paths.homeDir, '.local', 'share', 'opencode'),
      );
      const document = JSON.parse(await readFile(configPath, 'utf8')) as OpencodeConfig;
      expect(document.model).toBe('anthropic/claude-bench');
      expect(document.permission).toBe('allow');
      expect(document.provider.anthropic?.options).toEqual({
        apiKey: '{env:BENCH_OPENCODE_API_KEY}',
        baseURL: 'https://gateway.example/v1',
      });
      expect(Object.keys(document.mcp)).toHaveLength(4);
    } finally {
      await cleanup();
    }
  });

  it('treats supported providers as native without a base URL', async () => {
    const { context, paths, cleanup } = await createTestContext('opencode', 'direct', {
      BENCH_OPENCODE_API_KEY: 'sk-test',
      BENCH_OPENCODE_MODEL: 'deepseek/deepseek-flash',
    });
    try {
      const prepared = await prepareOpencodeRun(context);
      expect(prepared.model).toBe('deepseek/deepseek-flash');
      const configPath = join(paths.homeDir, '.config', 'opencode', 'opencode.json');
      const document = JSON.parse(await readFile(configPath, 'utf8')) as OpencodeConfig;
      expect(document.provider.deepseek?.options).toEqual({
        apiKey: '{env:BENCH_OPENCODE_API_KEY}',
      });
      expect(document.provider.deepseek?.npm).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('treats OpenRouter as a native provider in the V1 config', async () => {
    const { context, paths, cleanup } = await createTestContext('opencode', 'direct', {
      BENCH_OPENCODE_API_KEY: 'sk-test',
      BENCH_OPENCODE_BASE_URL: 'https://openrouter.ai/api/v1',
      BENCH_OPENCODE_MODEL: 'openrouter/~deepseek/deepseek-flash-latest',
    });
    try {
      const prepared = await prepareOpencodeRun(context);
      expect(prepared.model).toBe('openrouter/~deepseek/deepseek-flash-latest');
      const configPath = join(paths.homeDir, '.config', 'opencode', 'opencode.json');
      const document = JSON.parse(await readFile(configPath, 'utf8')) as OpencodeConfig;
      expect(document.provider.openrouter?.options).toEqual({
        apiKey: '{env:BENCH_OPENCODE_API_KEY}',
        baseURL: 'https://openrouter.ai/api/v1',
      });
      expect(document.provider.openrouter?.npm).toBeUndefined();
      expect(document.provider.openrouter?.models).toEqual({
        '~deepseek/deepseek-flash-latest': { name: '~deepseek/deepseek-flash-latest' },
      });
    } finally {
      await cleanup();
    }
  });

  it('writes the native V2 config with Code Mode MCP servers', async () => {
    const { context, paths, cleanup } = await createTestContext('opencode-v2', 'direct', {
      BENCH_OPENCODE_API_KEY: 'sk-test',
      BENCH_OPENCODE_BASE_URL: 'https://openrouter.ai/api/v1',
      BENCH_OPENCODE_MODEL: 'openrouter/~deepseek/deepseek-flash-latest',
    });
    try {
      const prepared = await prepareOpencodeRun(context);
      expect(prepared.usageSource).toBe('opencode');
      const configPath = join(paths.homeDir, '.config', 'opencode', 'opencode.json');
      const document = JSON.parse(await readFile(configPath, 'utf8')) as OpencodeV2Config;
      expect(document.provider).toBeUndefined();
      expect(document.providers?.openrouter?.settings).toEqual({
        apiKey: '{env:BENCH_OPENCODE_API_KEY}',
        baseURL: 'https://openrouter.ai/api/v1',
      });
      expect(document.providers?.openrouter?.models).toEqual({
        '~deepseek/deepseek-flash-latest': { modelID: '~deepseek/deepseek-flash-latest' },
      });
      const servers = document.mcp.servers ?? {};
      expect(Object.keys(servers)).toHaveLength(4);
      expect(servers.notion).toMatchObject({ type: 'local', disabled: false });
      expect(servers.notion?.command?.[0]).toBe('tsx');
    } finally {
      await cleanup();
    }
  });

  it('maps a custom provider to an AI SDK package in the V2 config', async () => {
    const { context, paths, cleanup } = await createTestContext('opencode-v2', 'router', {
      BENCH_OPENCODE_API_KEY: 'sk-test',
      BENCH_OPENCODE_BASE_URL: 'https://acme.example/api/v1',
      BENCH_OPENCODE_MODEL: 'acme/some-model',
    });
    try {
      await prepareOpencodeRun(context);
      const configPath = join(paths.homeDir, '.config', 'opencode', 'opencode.json');
      const document = JSON.parse(await readFile(configPath, 'utf8')) as OpencodeV2Config;
      expect(document.providers?.acme?.package).toBe('aisdk:@ai-sdk/openai-compatible');
      expect(document.providers?.acme?.settings).toEqual({
        apiKey: '{env:BENCH_OPENCODE_API_KEY}',
        baseURL: 'https://acme.example/api/v1',
      });
      expect(document.providers?.acme?.models).toEqual({
        'some-model': { modelID: 'some-model' },
      });
      expect(Object.keys(document.mcp.servers ?? {})).toEqual(['mcp-compress-router']);
    } finally {
      await cleanup();
    }
  });

  it('declares a custom OpenAI-compatible provider when needed', async () => {
    const { context, paths, cleanup } = await createTestContext('opencode', 'router', {
      BENCH_OPENCODE_API_KEY: 'sk-test',
      BENCH_OPENCODE_BASE_URL: 'https://acme.example/api/v1',
      BENCH_OPENCODE_MODEL: 'acme/some-model',
    });
    try {
      await prepareOpencodeRun(context);
      const configPath = join(paths.homeDir, '.config', 'opencode', 'opencode.json');
      const document = JSON.parse(await readFile(configPath, 'utf8')) as OpencodeConfig;
      expect(document.provider.acme?.npm).toBe('@ai-sdk/openai-compatible');
      expect(document.provider.acme?.models).toEqual({
        'some-model': { name: 'some-model' },
      });
      expect(Object.keys(document.mcp)).toEqual(['mcp-compress-router']);
    } finally {
      await cleanup();
    }
  });

  it('rejects custom providers without a base URL and malformed model refs', async () => {
    const withoutBaseUrl = await createTestContext('opencode', 'direct', {
      BENCH_OPENCODE_API_KEY: 'sk-test',
      BENCH_OPENCODE_MODEL: 'acme/some-model',
    });
    try {
      await expect(prepareOpencodeRun(withoutBaseUrl.context)).rejects.toThrow(
        /BENCH_OPENCODE_BASE_URL/,
      );
    } finally {
      await withoutBaseUrl.cleanup();
    }
    const badModel = await createTestContext('opencode', 'direct', {
      BENCH_OPENCODE_API_KEY: 'sk-test',
      BENCH_OPENCODE_MODEL: 'no-provider',
    });
    try {
      await expect(prepareOpencodeRun(badModel.context)).rejects.toThrow(
        /BENCH_OPENCODE_MODEL must be/,
      );
    } finally {
      await badModel.cleanup();
    }
    expect(splitModelRef('anthropic/claude-bench')).toEqual({
      provider: 'anthropic',
      model: 'claude-bench',
    });
  });
});
