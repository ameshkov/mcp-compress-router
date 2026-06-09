/**
 * Recognized transport types for downstream MCP servers.
 */
export type ServerTransportType = 'stdio' | 'http' | 'streamable-http';

/**
 * Parsed definition of a single downstream MCP server from mcp.json.
 */
export interface DownstreamServerConfig {
  /** Unique server name (the object key in mcpServers). */
  name: string;
  /** Transport type. */
  type: ServerTransportType;
  /** The executable to spawn (required for stdio). */
  command?: string;
  /** Optional command-line arguments. */
  args?: string[];
  /** Optional environment variables. */
  env?: Record<string, string>;
  /** Streamable HTTP endpoint URL (required for http / streamable-http). */
  url?: string;
  /** Optional static HTTP headers. */
  headers?: Record<string, string>;
  /** Optional human-authored description for the catalog. */
  description?: string;
  /** Optional OAuth client configuration overrides, with ${VAR} expansion. */
  oauth?: OAuthConfig;
}

/**
 * OAuth client configuration overrides from mcp.json "oauth" block.
 * When present, dynamic client registration is skipped and these values
 * are used instead.
 */
export interface OAuthConfig {
  /** Pre-registered OAuth client ID. ${VAR} expanded during config load. */
  clientId?: string;
  /** Pre-registered OAuth client secret. ${VAR} expanded during config load. */
  clientSecret?: string;
  /** Space-delimited scope string. ${VAR} expanded during config load. */
  scope?: string;
}

/**
 * OAuth tokens and client registration for a single downstream server,
 * persisted in mcp.json under the "credentials" top-level key.
 */
export interface StoredCredentials {
  /**
   * The full dynamic client registration response.
   * undefined when oauth overrides are used (clientId/clientSecret
   * provided in config).
   */
  clientRegistration?: Record<string, unknown>;
  /** OAuth tokens (access, refresh, expiry, scope, token_type). */
  tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type: string;
  };
}

/**
 * Per-server stored credentials map, keyed by server name.
 * Persisted as the "credentials" top-level key in mcp.json.
 */
export type CredentialsStore = Record<string, StoredCredentials>;

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
