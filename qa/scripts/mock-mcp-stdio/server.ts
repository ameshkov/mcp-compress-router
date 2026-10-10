#!/usr/bin/env node
/**
 * Mock MCP server for manual QA testing (stdio transport).
 *
 * Runs inside the QA workspace and is spawned by the router exactly like
 * a real local MCP server. Its tools are shared with the HTTP mock
 * (`qa/scripts/mock-mcp-tools.ts`), so the plans can verify the same
 * catalog, round trips, and error passthrough over both transports.
 *
 * Tools: `echo`, `add`, `multi_block`, `failing_tool`,
 * `documented_tool`, `slow_tool`. With `MOCK_MCP_TOOLS=weather` it
 * serves the lifelike weather tools (`mock-mcp-weather.ts`) instead,
 * which is what the real-LLM plans use.
 *
 * Environment:
 * - `MOCK_STARTUP_DELAY_MS` — delay before connecting, for
 *   startup-timeout scenarios.
 * - `MOCK_MCP_TOOLS` — `qa` (default) for the generic QA tools, or
 *   `weather` for the lifelike weather tools.
 * - `MOCK_CALL_LOG` — append one line per incoming request (e.g.
 *   `tools/call add`) to that file. The real-LLM plans set it to prove
 *   the model actually drove the server; the mock's stdout is the MCP
 *   protocol stream, so a file is the only channel available.
 *
 * Usage (from the repository root):
 *   node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts
 */
import { appendFile } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createMockMcpServer } from '../mock-mcp-tools.js';
import { createWeatherMcpServer } from '../mock-mcp-weather.js';

/**
 * Returns the configured startup delay in milliseconds.
 *
 * @returns The delay, or 0 when unset or invalid.
 */
function startupDelayMs(): number {
  const raw = Number(process.env.MOCK_STARTUP_DELAY_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Appends one incoming request to the optional call log. Best-effort:
 * a write failure never affects the protocol stream.
 *
 * @param logPath - Destination file (appended, created on first write).
 * @param message - The incoming JSON-RPC message.
 */
function logRequest(logPath: string, message: JSONRPCMessage): void {
  const method = 'method' in message ? message.method : 'response';
  const params =
    'params' in message ? (message.params as { name?: string } | undefined) : undefined;
  const name = params?.name;
  const line = `[qa-mock-stdio] ${method}${name === undefined ? '' : ` ${name}`}\n`;
  appendFile(logPath, line).catch(() => {});
}

/**
 * Starts the mock server on stdio.
 */
async function main(): Promise<void> {
  const delayMs = startupDelayMs();
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const server =
    process.env.MOCK_MCP_TOOLS === 'weather'
      ? createWeatherMcpServer('qa-mock-weather')
      : createMockMcpServer('qa-mock-stdio');
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const callLogPath = process.env.MOCK_CALL_LOG;
  if (callLogPath) {
    const originalOnMessage = transport.onmessage;
    transport.onmessage = (message) => {
      logRequest(callLogPath, message);
      originalOnMessage?.(message);
    };
  }
}

main().catch((err: unknown) => {
  console.error('[qa-mock-stdio] Fatal error:', err);
  process.exit(1);
});
