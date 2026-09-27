/**
 * Registry of the benchmark mock MCP servers.
 *
 * The benchmark reproduces a realistic "several MCP servers connected"
 * setup with four stdio servers whose tool surfaces are vendored from
 * popular public servers (Notion, GitHub, Figma, Playwright). Every tool
 * is a stub: listing it costs context, calling it fails with a
 * "not implemented" result.
 */
import { figmaTools } from './servers/figma.js';
import { githubTools } from './servers/github.js';
import { notionTools } from './servers/notion.js';
import { playwrightTools } from './servers/playwright.js';
import type { Tool } from './tool.js';

/** Names of the mock MCP servers the benchmark can expose. */
export const MOCK_SERVER_NAMES = ['notion', 'github', 'figma', 'playwright'] as const;

/** One of the mock MCP server names. */
export type MockServerName = (typeof MOCK_SERVER_NAMES)[number];

/** Tool definitions per mock server, keyed by server name. */
const TOOLS_BY_SERVER: Record<MockServerName, Tool[]> = {
  notion: notionTools,
  github: githubTools,
  figma: figmaTools,
  playwright: playwrightTools,
};

/**
 * Checks whether a string names a mock MCP server.
 *
 * @param value - The candidate server name.
 * @returns True when the value is a known mock server name.
 */
export function isMockServerName(value: string): value is MockServerName {
  return (MOCK_SERVER_NAMES as readonly string[]).includes(value);
}

/**
 * Returns the tool definitions advertised by one mock server.
 *
 * @param name - The mock server name.
 * @returns The server's tool definitions.
 */
export function getMockTools(name: MockServerName): Tool[] {
  return TOOLS_BY_SERVER[name];
}

/**
 * Returns the tool count of every mock server.
 *
 * @returns One entry per mock server with its advertised tool count.
 */
export function getMockServerSummary(): Array<{ name: MockServerName; tools: number }> {
  return MOCK_SERVER_NAMES.map((name) => ({ name, tools: TOOLS_BY_SERVER[name].length }));
}
