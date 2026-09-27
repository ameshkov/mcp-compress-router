import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { getMockTools } from './registry.js';

describe('mock MCP stdio server', () => {
  it('lists the vendored tools and rejects every call with a not-implemented error', async () => {
    const logDir = await mkdtemp(join(tmpdir(), 'bench-mock-mcp-test-'));
    const logPath = join(logDir, 'invocations.ndjson');
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      MOCK_MCP_LOG: logPath,
    };
    const transport = new StdioClientTransport({
      command: join(process.cwd(), 'node_modules', '.bin', 'tsx'),
      args: ['bench/scripts/mock-mcp/server.ts', '--server', 'notion'],
      env,
    });
    const client = new Client({ name: 'bench-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        getMockTools('notion').map((tool) => tool.name),
      );
      const result = await client.callTool({ name: 'notion-search', arguments: {} });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.text ?? '').toContain('not implemented');
      const log = await readFile(logPath, 'utf8');
      expect(log.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(log.trim())).toMatchObject({ server: 'notion', tool: 'notion-search' });
    } finally {
      await client.close();
      await rm(logDir, { recursive: true, force: true });
    }
  }, 20_000);
});
