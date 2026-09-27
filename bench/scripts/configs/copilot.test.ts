import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareCopilotRun } from './copilot.js';
import { createTestContext } from './test-support.js';

/** Minimal shape of the generated mcp-config.json used by the tests. */
interface CopilotMcpConfig {
  mcpServers: Record<string, { type: string; command: string; args: string[]; tools: string[] }>;
}

describe('Copilot CLI benchmark config', () => {
  it('writes a hermetic BYOK environment and the MCP config', async () => {
    const { context, paths, cleanup } = await createTestContext('copilot', 'direct', {
      BENCH_COPILOT_API_KEY: 'tg-test',
      BENCH_COPILOT_BASE_URL: 'https://gateway.example/api/v1',
      BENCH_COPILOT_MODEL: 'deepseek-flash',
      COPILOT_GITHUB_TOKEN: 'host-token',
      GH_TOKEN: 'host-gh-token',
      COPILOT_PROVIDER_BASE_URL: 'https://host.example/v1',
    });
    try {
      const prepared = await prepareCopilotRun(context);
      const copilotHome = join(paths.homeDir, '.copilot');
      expect(prepared.command).toBe('copilot');
      expect(prepared.args).toContain('--output-format');
      expect(prepared.args).toContain('--allow-all-tools');
      expect(prepared.env.COPILOT_HOME).toBe(copilotHome);
      expect(prepared.env.COPILOT_CACHE_HOME).toBe(join(paths.homeDir, '.cache', 'copilot'));
      expect(prepared.env.COPILOT_OFFLINE).toBe('true');
      expect(prepared.env.COPILOT_AUTO_UPDATE).toBe('false');
      expect(prepared.env.COPILOT_PROVIDER_TYPE).toBe('openai');
      expect(prepared.env.COPILOT_PROVIDER_BASE_URL).toBe('https://gateway.example/api/v1');
      expect(prepared.env.COPILOT_PROVIDER_API_KEY).toBe('tg-test');
      expect(prepared.env.COPILOT_MODEL).toBe('deepseek-flash');
      expect(prepared.env.COPILOT_GITHUB_TOKEN).toBeUndefined();
      expect(prepared.env.GH_TOKEN).toBeUndefined();
      expect(prepared.env.COPILOT_PROVIDER_WIRE_API).toBeUndefined();
      expect(prepared.usageSource).toBe('copilot');
      expect(prepared.usageEnv.COPILOT_HOME).toBe(copilotHome);
      const config = JSON.parse(
        await readFile(join(copilotHome, 'mcp-config.json'), 'utf8'),
      ) as CopilotMcpConfig;
      expect(Object.keys(config.mcpServers)).toHaveLength(4);
      expect(config.mcpServers.notion?.type).toBe('local');
      expect(config.mcpServers.notion?.tools).toEqual(['*']);
    } finally {
      await cleanup();
    }
  });

  it('passes the wire API through and keeps only the router in router mode', async () => {
    const { context, paths, cleanup } = await createTestContext('copilot', 'router', {
      BENCH_COPILOT_API_KEY: 'tg-test',
      BENCH_COPILOT_BASE_URL: 'https://gateway.example/api/v1',
      BENCH_COPILOT_MODEL: 'gpt-5.6-sol',
      BENCH_COPILOT_WIRE_API: 'responses',
    });
    try {
      const prepared = await prepareCopilotRun(context);
      expect(prepared.env.COPILOT_PROVIDER_WIRE_API).toBe('responses');
      const config = JSON.parse(
        await readFile(join(paths.homeDir, '.copilot', 'mcp-config.json'), 'utf8'),
      ) as CopilotMcpConfig;
      expect(Object.keys(config.mcpServers)).toEqual(['mcp-compress-router']);
    } finally {
      await cleanup();
    }
  });

  it('rejects missing credentials', async () => {
    const missing = await createTestContext('copilot', 'direct', { BENCH_COPILOT_MODEL: 'x' });
    try {
      await expect(prepareCopilotRun(missing.context)).rejects.toThrow(/BENCH_COPILOT_API_KEY/);
    } finally {
      await missing.cleanup();
    }
  });
});
