#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

async function main() {
  const server = new McpServer({
    name: 'test-fixture',
    version: '1.0.0',
  });

  server.registerTool(
    'echo',
    {
      title: 'Echo Tool',
      description: 'Returns the input message unchanged.',
      inputSchema: {
        message: z.string().describe('The message to echo.'),
      },
    },
    async (params) => {
      return {
        content: [{ type: 'text' as const, text: params.message }],
      };
    },
  );

  server.registerTool(
    'add',
    {
      title: 'Add Tool',
      description: 'Adds two numbers together.',
      inputSchema: {
        a: z.number().describe('The first number.'),
        b: z.number().describe('The second number.'),
      },
    },
    async (params) => {
      const result = params.a + params.b;
      return {
        content: [{ type: 'text' as const, text: String(result) }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[test-fixture] Fatal error:', err);
  process.exit(1);
});
