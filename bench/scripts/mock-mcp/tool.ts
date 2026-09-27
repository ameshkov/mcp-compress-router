/**
 * Tool-definition helper for the benchmark mock MCP servers.
 *
 * The benchmark exposes vendored copies of the public tool surfaces of
 * several popular MCP servers (Notion, GitHub, Figma, Playwright). The
 * definitions exist only to reproduce the context overhead those servers
 * add to a coding agent; every tool call fails with a "not implemented"
 * result, and the test prompt never needs them.
 *
 * Keep the definitions representative rather than exhaustive: names,
 * descriptions, and input schemas should look like the real servers so
 * the measured token overhead stays realistic.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type { Tool };

/** JSON Schema property map for one tool input. */
export type ToolProperties = Record<string, object>;

/**
 * Builds one MCP tool definition from its parts.
 *
 * @param name - The bare tool name, as advertised by the real server.
 * @param description - The tool description sent to the model.
 * @param properties - JSON Schema properties for the tool input.
 * @param required - Names of the required input properties.
 * @returns An MCP tool definition with an object input schema.
 */
export function tool(
  name: string,
  description: string,
  properties: ToolProperties,
  required: string[] = [],
): Tool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required },
  };
}
