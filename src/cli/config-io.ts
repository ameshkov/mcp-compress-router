import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CredentialsStore, StoredCredentials } from '../utils/types.js';

/**
 * Type guard for Node.js system errors that carry a `code` property.
 *
 * @param err - The error to inspect.
 * @returns True if the error has a string `code` property (e.g., 'ENOENT').
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

/**
 * Raw server entry as stored in mcp.json (unvalidated).
 * @internal — Exported for tests only; not part of the public module API.
 */
export interface RawServerEntry {
  type: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
}

/**
 * Map of server names to their raw entries.
 * @internal — Exported for internal CLI module use; not part of the public module API.
 */
export type McpServers = Record<string, RawServerEntry>;

/**
 * Ensures the parent directory and config file exist.
 * If the file does not exist, creates it with an empty mcpServers object.
 * Idempotent — does nothing if the file already exists.
 *
 * @param configPath - Absolute path to the mcp.json file.
 */
export async function ensureConfigDir(configPath: string): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  try {
    await fs.access(configPath);
  } catch {
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
  }
}

/**
 * Reads the mcpServers object from the config file.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @returns The raw mcpServers object.
 * @throws If the file is missing, invalid JSON, or missing mcpServers key.
 */
export async function readConfigFile(configPath: string): Promise<McpServers> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf-8');
  } catch {
    throw new Error(`Config file not found: ${configPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse config file: ${configPath}`);
  }

  if (typeof parsed !== 'object' || parsed === null || !('mcpServers' in parsed)) {
    throw new Error(`Config file must contain an mcpServers object`);
  }

  return (parsed as Record<string, unknown>).mcpServers as McpServers;
}

/**
 * Writes the mcpServers object to the config file.
 * Preserves any top-level keys other than mcpServers.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param mcpServers - The mcpServers object to write.
 */
export async function writeConfigFile(configPath: string, mcpServers: McpServers): Promise<void> {
  // Preserve any existing top-level keys (e.g., credentials stored by OAuth flow)
  let existing: Record<string, unknown> = { mcpServers: {} };
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File doesn't exist or is invalid — start fresh
  }

  existing.mcpServers = mcpServers;
  await fs.writeFile(configPath, JSON.stringify(existing, null, 2) + '\n');
}

/**
 * Reads the credentials object from the config file.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @returns The credentials store, or empty object if the file does not exist.
 * @throws If the file exists but cannot be read (permission denied) or
 *   contains invalid JSON.
 */
export async function readCredentials(configPath: string): Promise<CredentialsStore> {
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.credentials &&
      typeof parsed.credentials === 'object' &&
      parsed.credentials !== null
    ) {
      return parsed.credentials as CredentialsStore;
    }
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      // File doesn't exist — return empty, equivalent to no credentials.
    } else {
      // Permission denied, corrupt JSON, or disk I/O error — propagate.
      throw new Error(`Failed to read credentials from config file: ${configPath}`, { cause: err });
    }
  }
  return {};
}

/**
 * Writes (or overwrites) credentials for a single server.
 * Preserves existing mcpServers and credentials for other servers.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name.
 * @param credentials - The credentials to store.
 */
export async function writeCredentials(
  configPath: string,
  name: string,
  credentials: StoredCredentials,
): Promise<void> {
  let existing: Record<string, unknown> = { mcpServers: {} };
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Start fresh
  }

  const creds: Record<string, unknown> =
    existing.credentials && typeof existing.credentials === 'object'
      ? { ...(existing.credentials as Record<string, unknown>) }
      : {};
  creds[name] = credentials;

  existing.credentials = creds;
  await fs.writeFile(configPath, JSON.stringify(existing, null, 2) + '\n');
}

/**
 * Removes credentials for a server from the config file.
 * No-op if the server has no stored credentials.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name.
 */
export async function removeCredentials(configPath: string, name: string): Promise<void> {
  let existing: Record<string, unknown> = { mcpServers: {} };
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  if (existing.credentials && typeof existing.credentials === 'object') {
    const creds = { ...(existing.credentials as Record<string, unknown>) };
    delete creds[name];
    existing.credentials = creds;
    await fs.writeFile(configPath, JSON.stringify(existing, null, 2) + '\n');
  }
}
