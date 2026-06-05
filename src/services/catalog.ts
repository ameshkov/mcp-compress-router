import type { ToolCatalog, ToolDescriptor } from '../utils/index.js';
import type { DiscoveredServer } from './discovery.js';

/**
 * Builds the immutable tool catalog from discovered server data.
 *
 * @param discovered - Results from parallel discovery.
 * @returns An immutable ToolCatalog.
 */
export function buildCatalog(discovered: DiscoveredServer[]): ToolCatalog {
  const toolMap = new Map<string, ToolDescriptor>();

  const servers = discovered.map((ds) => {
    for (const tool of ds.tools) {
      const key = `${ds.name}::${tool.name}`;
      toolMap.set(key, tool);
    }

    return {
      name: ds.name,
      description: ds.description,
      tools: ds.tools,
    };
  });

  return { servers, toolMap };
}

/**
 * Looks up tool schemas in the catalog by server and tool names.
 *
 * @param catalog - The tool catalog.
 * @param serverName - The server to look up.
 * @param toolNames - The tool names to retrieve.
 * @returns The matching tool descriptors.
 * @throws If the server or any tool is not found.
 */
export function lookupTools(
  catalog: ToolCatalog,
  serverName: string,
  toolNames: string[],
): ToolDescriptor[] {
  const server = catalog.servers.find((s) => s.name === serverName);
  if (!server) {
    const available = catalog.servers.map((s) => s.name).join(', ');
    throw new Error(`Server "${serverName}" not found. Available servers: ${available}`);
  }

  const results: ToolDescriptor[] = [];
  const missing: string[] = [];

  for (const toolName of toolNames) {
    const key = `${serverName}::${toolName}`;
    const tool = catalog.toolMap.get(key);
    if (!tool) {
      missing.push(toolName);
    } else {
      results.push(tool);
    }
  }

  if (missing.length > 0) {
    const valid = server.tools.map((t) => t.name).join(', ');
    throw new Error(
      `Tool(s) not found on server "${serverName}": ${missing.join(', ')}. Valid tools: ${valid}`,
    );
  }

  return results;
}
