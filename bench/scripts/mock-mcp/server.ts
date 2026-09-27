#!/usr/bin/env node
/**
 * Mock MCP stdio server for the benchmark.
 *
 * Serves one vendored tool surface (Notion, GitHub, Figma, or
 * Playwright) over the MCP stdio transport. The server exists to make
 * the benchmark's MCP configuration realistic: agents see the same kind
 * of verbose tool definitions they would see from the real servers.
 *
 * Every tool call is answered with an "not implemented" error and, when
 * `MOCK_MCP_LOG` is set, appended as one JSON line to that file so the
 * benchmark can prove the test prompt never needed the tools.
 *
 * Usage:
 *   tsx bench/scripts/mock-mcp/server.ts --server notion
 *
 * Environment:
 *   MOCK_MCP_LOG  Optional path of the tool-invocation log (NDJSON).
 */
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getMockTools, isMockServerName, MOCK_SERVER_NAMES } from './registry.js';

/** Parsed command-line arguments. */
interface ServerArgs {
  server: string;
}

/**
 * Parses `--server <name>` from the command line.
 *
 * @param argv - Arguments after the script name.
 * @returns The parsed arguments.
 * @throws Error when `--server` is missing or unknown.
 */
function parseArgs(argv: string[]): ServerArgs {
  const index = argv.indexOf('--server');
  const server = index === -1 ? '' : (argv[index + 1] ?? '');
  if (!isMockServerName(server)) {
    throw new Error(
      `Missing or unknown --server value "${server}". Expected one of: ${MOCK_SERVER_NAMES.join(', ')}.`,
    );
  }
  return { server };
}

/**
 * Builds and connects the mock server for one tool surface.
 *
 * @param server - The mock server name.
 */
async function main(server: string): Promise<void> {
  if (!isMockServerName(server)) {
    throw new Error(`Unknown mock server: ${server}`);
  }
  const tools = getMockTools(server);
  const mcp = new Server(
    { name: `bench-mock-${server}`, version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  mcp.setRequestHandler(CallToolRequestSchema, (request) => {
    const logPath = process.env.MOCK_MCP_LOG;
    if (logPath !== undefined && logPath !== '') {
      const record = JSON.stringify({
        server,
        tool: request.params.name,
        timestamp: new Date().toISOString(),
      });
      appendFileSync(logPath, `${record}\n`, 'utf8');
    }
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `The "${request.params.name}" tool from the "${server}" benchmark fixture is ` +
            'not implemented. Do not call it; implement the task with local tools instead.',
        },
      ],
      isError: true,
    };
  });
  await mcp.connect(new StdioServerTransport());
}

try {
  const { server } = parseArgs(process.argv.slice(2));
  await main(server);
} catch (error) {
  console.error(`bench mock MCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
