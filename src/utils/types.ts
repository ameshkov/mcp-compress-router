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
 * Per-server OAuth requirement determined by probing the server's OAuth
 * discovery endpoint. Persisted as an optional field inside the server's
 * `credentials.json` entry.
 *
 * - `'oauth'` — the server advertises OAuth metadata.
 * - `'none'` — the server does not advertise OAuth metadata.
 * - `'unknown'` — the probe failed or was never run.
 */
export type AuthRequirement = 'oauth' | 'none' | 'unknown';

/**
 * The final auth status label shown in the `list` table. Derived at
 * list time from the cached auth requirement, stored tokens, and
 * configured HTTP headers — no network access.
 *
 * - `'none'` — stdio server, no auth possible.
 * - `'header'` — http server with a static `Authorization` header.
 * - `'authenticated'` — http server advertising OAuth with stored tokens.
 * - `'requires login'` — http server advertising OAuth without tokens.
 * - `'public'` — http server that does not advertise OAuth.
 * - `'unknown'` — http server whose OAuth support could not be determined.
 */
export type AuthStatus =
  | 'none'
  | 'header'
  | 'authenticated'
  | 'requires login'
  | 'public'
  | 'unknown';

/**
 * OAuth tokens and client registration for a single downstream server,
 * persisted in credentials.json.
 *
 * `tokens` is optional: an entry may exist only to cache the server's
 * auth requirement (the pre-login state, or the post-logout state).
 */
export interface StoredCredentials {
  /**
   * The full dynamic client registration response.
   * undefined when oauth overrides are used (clientId/clientSecret
   * provided in config).
   */
  clientRegistration?: Record<string, unknown>;
  /**
   * OAuth tokens (access, refresh, expiry, scope, token_type).
   * Optional — may be absent for servers that were probed but never
   * logged in (an entry exists only to cache `authRequirement`).
   */
  tokens?: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type: string;
  };
  /** Cached OAuth requirement from a metadata probe. Undefined if never probed. */
  authRequirement?: AuthRequirement;
  /** ISO-8601 timestamp of when the auth-requirement probe last ran. */
  checkedAt?: string;
}

/**
 * Per-server stored credentials map, keyed by server name.
 * Persisted in credentials.json.
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
