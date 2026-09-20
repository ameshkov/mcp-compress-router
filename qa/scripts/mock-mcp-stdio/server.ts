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
 * `documented_tool`.
 *
 * Environment:
 * - `MOCK_STARTUP_DELAY_MS` — delay before connecting, for
 *   startup-timeout scenarios.
 *
 * Usage (from the repository root):
 *   node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMockMcpServer } from '../mock-mcp-tools.js';

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
 * Starts the mock server on stdio.
 */
async function main(): Promise<void> {
  const delayMs = startupDelayMs();
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const server = createMockMcpServer('qa-mock-stdio');
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error('[qa-mock-stdio] Fatal error:', err);
  process.exit(1);
});
