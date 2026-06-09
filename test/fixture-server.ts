#!/usr/bin/env node

/// <reference types="node" />

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

async function main() {
  const delayMs = process.env.FIXTURE_STARTUP_DELAY_MS;
  if (delayMs) {
    await new Promise((resolve) => setTimeout(resolve, parseInt(delayMs, 10)));
  }

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

  server.registerTool(
    'multi_block',
    {
      title: 'Multi-Block Tool',
      description: 'Returns multiple content blocks of different types.',
      inputSchema: {
        prefix: z.string().describe('A prefix for the first text block.'),
      },
    },
    async (params) => {
      return {
        content: [
          { type: 'text' as const, text: `${params.prefix}: first block` },
          {
            type: 'resource' as const,
            resource: {
              uri: 'test://fixture/block-2',
              text: 'second block as resource',
            },
          },
          { type: 'text' as const, text: 'third block' },
        ],
      };
    },
  );

  server.registerTool(
    'failing_tool',
    {
      title: 'Failing Tool',
      description: 'Returns an error result with a specific message.',
      inputSchema: {
        message: z.string().describe('The error message to return.'),
      },
    },
    async (params) => {
      return {
        content: [{ type: 'text' as const, text: params.message }],
        isError: true as const,
      };
    },
  );

  server.registerTool(
    'crash',
    {
      title: 'Crash Tool',
      description:
        'Terminates the fixture server process immediately, ' +
        'simulating a downstream server crash.',
      inputSchema: {},
    },
    async () => {
      // Synchronous exit to prevent a clean JSON-RPC response,
      // causing the SDK transport to detect child process exit.
      process.exit(1);
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[test-fixture] Fatal error:', err);
  process.exit(1);
});
