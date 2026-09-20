/**
 * Shared tool definitions for the QA mock MCP servers.
 *
 * Both the stdio mock (`mock-mcp-stdio/`) and the streamable-http mock
 * (`mock-mcp-http/`) expose the same four tools so a scenario can run
 * against either transport and verify the same catalog, round trips,
 * and error passthrough.
 *
 * Tools:
 * - `echo(message)` — returns `echo: <message>`, so a round trip is
 *   distinguishable from the request arguments in the mock LLM log.
 * - `add(a, b)` — returns the sum of two numbers.
 * - `multi_block(prefix)` — returns three content blocks (text,
 *   resource, text) to verify content passthrough.
 * - `failing_tool(message)` — returns an `isError` result.
 * - `documented_tool(input)` — a deliberately long description (see
 *   `mock-long-description.ts`) for the description-passthrough plans.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { LONG_DESCRIPTION } from './mock-long-description.js';

/**
 * Registers the `echo` tool.
 *
 * @param server - The mock MCP server.
 */
function registerEcho(server: McpServer): void {
  server.registerTool(
    'echo',
    {
      title: 'Echo Tool',
      description: 'Returns the input message with an "echo: " prefix.',
      inputSchema: {
        message: z.string().describe('The message to echo.'),
      },
    },
    async (params) => {
      return {
        content: [{ type: 'text' as const, text: `echo: ${params.message}` }],
      };
    },
  );
}

/**
 * Registers the `add` tool.
 *
 * @param server - The mock MCP server.
 */
function registerAdd(server: McpServer): void {
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
      return {
        content: [{ type: 'text' as const, text: String(params.a + params.b) }],
      };
    },
  );
}

/**
 * Registers the `multi_block` tool.
 *
 * @param server - The mock MCP server.
 */
function registerMultiBlock(server: McpServer): void {
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
              uri: 'mock://qa/block-2',
              text: 'second block as resource',
            },
          },
          { type: 'text' as const, text: 'third block' },
        ],
      };
    },
  );
}

/**
 * Registers the `failing_tool` tool.
 *
 * @param server - The mock MCP server.
 */
function registerFailingTool(server: McpServer): void {
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
}

/**
 * Registers the `documented_tool` tool.
 *
 * @param server - The mock MCP server.
 */
function registerDocumentedTool(server: McpServer): void {
  server.registerTool(
    'documented_tool',
    {
      title: 'Documented Tool',
      description: LONG_DESCRIPTION,
      inputSchema: {
        input: z.string().describe('The input to return with a prefix.'),
      },
    },
    async (params) => {
      return {
        content: [{ type: 'text' as const, text: `documented: ${params.input}` }],
      };
    },
  );
}

/**
 * Creates a mock MCP server with the shared QA tools.
 *
 * @param name - The server name reported during initialize.
 * @returns The ready-to-connect MCP server.
 */
export function createMockMcpServer(name: string): McpServer {
  const server = new McpServer({ name, version: '1.0.0' });
  registerEcho(server);
  registerAdd(server);
  registerMultiBlock(server);
  registerFailingTool(server);
  registerDocumentedTool(server);
  return server;
}
