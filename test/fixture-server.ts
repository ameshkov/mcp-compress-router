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

  if (process.env.FIXTURE_EMPTY_TOOLS !== '1') {
    registerTools(server);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Registers the fixture's standard tool set on the given server.
 * Centralized so the `FIXTURE_EMPTY_TOOLS` mode can skip registration
 * entirely, producing a server that advertises zero tools.
 *
 * `FIXTURE_EXTRA_TOOLS` (a positive integer) additionally registers that
 * many deterministic `bulk_tool_###` tools, letting E2E tests grow the
 * catalog past the length-limited client cap without hand-writing tool
 * definitions.
 */
function registerTools(server: McpServer): void {
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

  server.registerTool(
    'echo_env',
    {
      title: 'Echo Environment Variable',
      description:
        'Returns the value of the requested environment variable, ' +
        'or an empty string when it is unset. Used to verify that a ' +
        'configured `env` map reaches the spawned child process.',
      inputSchema: {
        name: z.string().describe('The environment variable name to read.'),
      },
    },
    async (params) => {
      const value = process.env[params.name] ?? '';
      return {
        content: [{ type: 'text' as const, text: value }],
      };
    },
  );

  const extraTools = Number(process.env.FIXTURE_EXTRA_TOOLS ?? '');
  if (Number.isInteger(extraTools) && extraTools > 0) {
    registerBulkTools(server, extraTools);
  }
}

/**
 * Registers `count` deterministic bulk tools (`bulk_tool_001`, ...) with
 * a trivial schema, used by E2E tests that need an artificially large
 * catalog.
 *
 * @param server - The fixture server to register the tools on.
 * @param count - How many bulk tools to register.
 */
function registerBulkTools(server: McpServer, count: number): void {
  for (let index = 1; index <= count; index++) {
    const name = `bulk_tool_${String(index).padStart(3, '0')}`;
    server.registerTool(
      name,
      {
        title: `Bulk Tool ${index}`,
        description: `Bulk fixture tool number ${index}.`,
        inputSchema: {
          value: z.number().describe('An arbitrary value.'),
        },
      },
      async (params) => ({
        content: [{ type: 'text' as const, text: `${name}:${params.value}` }],
      }),
    );
  }
}

main().catch((err) => {
  console.error('[test-fixture] Fatal error:', err);
  process.exit(1);
});
