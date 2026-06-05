/**
 * Parsed definition of a single downstream MCP server from mcp.json.
 */
export interface DownstreamServerConfig {
  /** Unique server name (the object key in mcpServers). */
  name: string;
  /** The executable to spawn (stdio transport). */
  command: string;
  /** Optional command-line arguments. */
  args?: string[];
  /** Optional environment variables. */
  env?: Record<string, string>;
  /** Optional human-authored description for the catalog. */
  description?: string;
}

/**
 * A tool descriptor discovered from a downstream server.
 */
export interface ToolDescriptor {
  /** Tool name. */
  name: string;
  /** Human-readable description. */
  description?: string;
  /** JSON Schema for the tool's parameters. */
  inputSchema: Record<string, unknown>;
}

/**
 * A server entry in the immutable tool catalog.
 */
export interface CatalogServer {
  /** Server name. */
  name: string;
  /** Optional human-authored description. */
  description?: string;
  /** Tools provided by this server. */
  tools: ToolDescriptor[];
}

/**
 * The immutable tool catalog built at startup.
 */
export interface ToolCatalog {
  /** Servers ordered as discovered. */
  servers: CatalogServer[];
  /** Fast lookup keyed by "server::tool". */
  toolMap: Map<string, ToolDescriptor>;
}
