import { filterTools } from '../utils/index.js';
import type { CompressionLevel, Logger } from '../utils/index.js';
import type { ToolCatalog, ToolDescriptor, ToolSelection } from '../utils/index.js';
import type { DiscoveredServer } from './discovery.js';

/**
 * Builds the immutable tool catalog from discovered server data, applying
 * per-server tool selection so filtered tools never enter the catalog.
 *
 * For each configured `allowedTools`/`disabledTools` pattern that matches
 * no discovered tool, emits a `debug`-level warning naming the server and
 * pattern. These warnings appear only under verbose logging (`-v`) and
 * never abort catalog construction — they signal config drift or a
 * renamed tool, per PRD §"Implementation Decisions".
 *
 * @param discovered - Results from parallel discovery (enabled servers only).
 * @param selectionByServer - Optional per-server allowlist/denylist. When a
 *   server name is absent from the map, all its tools are exposed.
 * @param logger - Optional logger for unmatched-pattern warnings. When
 *   omitted, no warnings are emitted (backward compatible).
 * @param compressionLevelByServer - Optional per-server compression level
 *   map. When a server name is absent or the entry is `undefined`, the
 *   level resolves to `high` (the default).
 * @returns An immutable ToolCatalog containing only exposed tools.
 */
export function buildCatalog(
  discovered: DiscoveredServer[],
  selectionByServer: Map<string, ToolSelection> = new Map(),
  logger?: Logger,
  compressionLevelByServer: Map<string, CompressionLevel | undefined> = new Map(),
): ToolCatalog {
  const toolMap = new Map<string, ToolDescriptor>();
  const filteredToolNames = new Set<string>();

  const servers = discovered.map((ds) => {
    const selection = selectionByServer.get(ds.name);
    const { exposed, entries, unmatchedPatterns } = filterTools(
      ds.tools,
      selection?.allowedTools,
      selection?.disabledTools,
    );

    for (const tool of exposed) {
      toolMap.set(`${ds.name}::${tool.name}`, tool);
    }
    for (const entry of entries) {
      if (entry.decision === 'filtered') {
        filteredToolNames.add(`${ds.name}::${entry.descriptor.name}`);
      }
    }
    for (const pattern of unmatchedPatterns) {
      logger?.debug(
        `Configured tool pattern matched no discovered tool on server "${ds.name}": "${pattern}"`,
        { server: ds.name, pattern },
      );
    }

    return {
      name: ds.name,
      description: ds.description,
      tools: exposed,
      compressionLevel: compressionLevelByServer.get(ds.name) ?? 'high',
    };
  });

  return { servers, toolMap, filteredToolNames };
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
  const filtered: string[] = [];

  for (const toolName of toolNames) {
    const key = `${serverName}::${toolName}`;
    const tool = catalog.toolMap.get(key);
    if (tool) {
      results.push(tool);
      continue;
    }
    if (catalog.filteredToolNames.has(key)) {
      filtered.push(toolName);
    } else {
      missing.push(toolName);
    }
  }

  if (missing.length > 0 || filtered.length > 0) {
    const valid = server.tools.map((t) => t.name).join(', ');
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`Tool(s) not found on server "${serverName}": ${missing.join(', ')}.`);
    }
    if (filtered.length > 0) {
      parts.push(
        `Tool(s) filtered out on server "${serverName}" (excluded by allowedTools/disabledTools): ${filtered.join(', ')}.`,
      );
    }
    parts.push(`Valid tools: ${valid}`);
    throw new Error(parts.join(' '));
  }

  return results;
}
