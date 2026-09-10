import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';
import type { CredentialsStore, StoredCredentials } from '../utils/types.js';
import { parseJsonc } from '../utils/index.js';

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
 */
export interface RawServerEntry {
  type: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  /** Whether the server is enabled. Absent means enabled (default). */
  enabled?: boolean;
  /** Glob patterns allowlisting tool names; empty array means no tools. */
  allowedTools?: string[];
  /** Glob patterns denylisting tool names; wins over allowedTools. */
  disabledTools?: string[];
  /** Tool listing compression level (max, high, medium, low). */
  compressionLevel?: string;
  /** OAuth client overrides (clientId/clientSecret/scope/callbackPort). */
  oauth?: Record<string, unknown>;
}

/**
 * Map of server names to their raw entries.
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
    parsed = parseJsonc(raw, configPath);
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
    existing = parseJsonc(raw, configPath) as Record<string, unknown>;
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

  const store = (await readCredentialsStore(credPath, 'writing')) ?? {};
  store[name] = credentials;

  const { isNewFile, mode } = await resolveCredentialsMode(credPath);

  // Write atomically (unique temporary sibling + rename): a crash or
  // forced exit can never leave credentials.json truncated, and
  // readCredentials treats invalid JSON as a hard startup error.
  await writeCredentialsFileAtomic(credPath, JSON.stringify(store, null, 2) + '\n', mode);

  // On first creation, set restrictive permissions (owner read/write only)
  if (isNewFile) {
    await restrictNewCredentialsFile(credPath, logger);
  }
}

/**
 * Reads the credentials store for a read-modify-write update. A missing
 * file yields `undefined`; any other failure (unreadable file or invalid
 * JSON) is fatal so a damaged store is never silently overwritten.
 *
 * @param credPath - Absolute path to credentials.json.
 * @param action - Action named in the error message.
 * @returns The stored credentials, or undefined when no file exists.
 */
async function readCredentialsStore(
  credPath: string,
  action: 'writing' | 'removal',
): Promise<CredentialsStore | undefined> {
  try {
    const raw = await fs.readFile(credPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as CredentialsStore;
    }
    return {};
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return undefined;
    }
    throw new Error(`Failed to read credentials file for ${action}: ${credPath}`, { cause: err });
  }
}

/**
 * Resolves the permissions to use when replacing the credentials file:
 * an existing file keeps its mode, a new file is created owner-only.
 *
 * @param credPath - Absolute path to credentials.json.
 * @returns Whether the file is new, and the mode to apply.
 */
async function resolveCredentialsMode(
  credPath: string,
): Promise<{ isNewFile: boolean; mode: number }> {
  try {
    const stat = await fs.stat(credPath);
    return { isNewFile: false, mode: stat.mode & 0o777 };
  } catch {
    return { isNewFile: true, mode: 0o600 };
  }
}

/**
 * Writes `data` atomically: the content goes to a unique temporary
 * sibling file first, then is renamed over the target, so a crash or a
 * forced exit can never leave a truncated credentials file behind.
 *
 * @param credPath - Target credentials file path.
 * @param data - Full file content to write.
 * @param mode - Permissions to create the replacement file with.
 */
async function writeCredentialsFileAtomic(
  credPath: string,
  data: string,
  mode: number,
): Promise<void> {
  const tempPath = `${credPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.writeFile(tempPath, data, { mode });
    await fs.rename(tempPath, credPath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

/**
 * Restricts a freshly created credentials file to owner read/write and
 * warns when the platform cannot enforce it.
 *
 * @param credPath - Absolute path to credentials.json.
 * @param logger - Optional logger for permission warnings.
 */
async function restrictNewCredentialsFile(credPath: string, logger?: Logger): Promise<void> {
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

  const store = await readCredentialsStore(credPath, 'removal');
  if (store === undefined) {
    // File does not exist — nothing to remove
    return;
  }

  delete store[name];

  if (Object.keys(store).length === 0) {
    // No remaining entries — delete the file entirely
    await fs.unlink(credPath);
  } else {
    const { mode } = await resolveCredentialsMode(credPath);
    await writeCredentialsFileAtomic(credPath, JSON.stringify(store, null, 2) + '\n', mode);
  }
}
