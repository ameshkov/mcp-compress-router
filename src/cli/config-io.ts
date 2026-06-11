import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';
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
 * Derives the credentials.json path from the config path.
 *
 * @param configPath - Absolute path to mcp.json.
 * @returns Absolute path to credentials.json in the same directory.
 */
function getCredentialsPath(configPath: string): string {
  return path.join(path.dirname(configPath), 'credentials.json');
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
 * Preserves non-credential top-level keys other than mcpServers.
 * Silently drops any legacy "credentials" key (credentials are now
 * stored in credentials.json).
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param mcpServers - The mcpServers object to write.
 */
export async function writeConfigFile(configPath: string, mcpServers: McpServers): Promise<void> {
  // Preserve any existing top-level keys except credentials
  // (credentials are stored in credentials.json)
  let existing: Record<string, unknown> = { mcpServers: {} };
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File doesn't exist or is invalid — start fresh
  }

  // Drop legacy credentials key that may exist from before the
  // credentials.json separation
  delete existing.credentials;

  existing.mcpServers = mcpServers;
  await fs.writeFile(configPath, JSON.stringify(existing, null, 2) + '\n');
}

/**
 * Reads the credentials object from credentials.json.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @returns The credentials store, or empty object if the file does not exist.
 * @throws If the file exists but cannot be read (permission denied) or
 *   contains invalid JSON.
 */
export async function readCredentials(configPath: string): Promise<CredentialsStore> {
  const credPath = getCredentialsPath(configPath);

  let raw: string;
  try {
    raw = await fs.readFile(credPath, 'utf-8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return {};
    }
    throw new Error(`Failed to read credentials file: ${credPath}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Credentials file contains invalid JSON: ${credPath}`, { cause: err });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Credentials file must contain a JSON object: ${credPath}`);
  }

  return parsed as CredentialsStore;
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
  logger?: Logger,
): Promise<void> {
  const credPath = getCredentialsPath(configPath);

  // Read existing store (or start fresh)
  let store: CredentialsStore = {};
  try {
    const raw = await fs.readFile(credPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed === 'object' && parsed !== null) {
      store = parsed as CredentialsStore;
    }
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      // File does not exist — will be created below
    } else {
      throw new Error(`Failed to read credentials file for writing: ${credPath}`, { cause: err });
    }
  }

  // Merge in the new/updated entry
  store[name] = credentials;

  // Determine if this is a first-time creation
  let isNewFile = false;
  try {
    await fs.access(credPath);
  } catch {
    isNewFile = true;
  }

  // Write the store
  await fs.writeFile(credPath, JSON.stringify(store, null, 2) + '\n');

  // On first creation, set restrictive permissions (owner read/write only)
  if (isNewFile) {
    try {
      await fs.chmod(credPath, 0o600);
    } catch {
      // chmod is a no-op on Windows; if it somehow fails on Unix, log a warning
      if (logger) {
        logger.info(
          `Warning: Failed to set restrictive permissions on new credentials file: ${credPath}`,
        );
      }
    }

    // On Windows, verify chmod did something; if not, log a warning
    if (process.platform === 'win32' && logger) {
      logger.info(
        `Warning: File permissions cannot be restricted on Windows. ` +
          `Credentials stored in: ${credPath}`,
      );
    }
  }
}

/**
 * Removes credentials for a server from the config file.
 * No-op if the server has no stored credentials.
 * Deletes the credentials file when the last entry is removed.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name.
 */
export async function removeCredentials(configPath: string, name: string): Promise<void> {
  const credPath = getCredentialsPath(configPath);

  let store: CredentialsStore = {};
  try {
    const raw = await fs.readFile(credPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed === 'object' && parsed !== null) {
      store = parsed as CredentialsStore;
    }
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      // File does not exist — nothing to remove
      return;
    }
    throw new Error(`Failed to read credentials file for removal: ${credPath}`, { cause: err });
  }

  delete store[name];

  if (Object.keys(store).length === 0) {
    // No remaining entries — delete the file entirely
    await fs.unlink(credPath);
  } else {
    await fs.writeFile(credPath, JSON.stringify(store, null, 2) + '\n');
  }
}
