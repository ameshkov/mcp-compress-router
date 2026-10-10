import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';
import type { CredentialsStore, ServerTimeoutInput, StoredCredentials } from '../utils/types.js';
import { atomicWriteFile, parseJsonc, withFileLock, type FileLockOptions } from '../utils/index.js';

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
 * Lock options for credentials.json mutations. A critical section is a
 * few file operations long, so a short stale window is safe: a crashed
 * holder is reclaimed quickly and a live one is never stolen (the holder
 * renews the lock file's mtime while it works). The timeout exceeds the
 * stale window so a crashed holder's lock is reclaimed before waiters
 * give up.
 */
const CREDENTIALS_LOCK_OPTIONS: FileLockOptions = {
  timeoutMs: 15_000,
  staleMs: 5_000,
  retryDelayMs: 25,
};

/**
 * Lock options for the cross-process OAuth refresh lock. Its critical
 * section includes authorization-server discovery and the token request,
 * both bounded by the server's resolved startup budget, so waiters get a
 * larger window than for plain file mutations.
 */
const REFRESH_LOCK_OPTIONS: FileLockOptions = {
  timeoutMs: 30_000,
  staleMs: 15_000,
  retryDelayMs: 25,
};

/**
 * Runs `task` while holding the cross-process lock that serializes
 * mutations of this config's credentials.json. Every writer of the shared
 * file goes through this lock so concurrent router instances, CLI
 * commands, and login flows cannot lose each other's updates.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param task - The mutation to run while holding the lock.
 * @returns The task's result.
 * @throws When the lock cannot be acquired before its timeout.
 */
async function withCredentialsLock<T>(configPath: string, task: () => Promise<T>): Promise<T> {
  const credPath = getCredentialsPath(configPath);
  return withFileLock(`${credPath}.lock`, task, CREDENTIALS_LOCK_OPTIONS);
}

/**
 * Runs `task` while holding the cross-process OAuth refresh lock for this
 * config's credentials.json. Token refreshes take this lock before
 * re-reading the stored tokens, so concurrent router instances refresh a
 * rotating refresh token exactly once instead of racing each other into
 * `invalid_grant`.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param task - The refresh operation to run while holding the lock.
 * @returns The task's result.
 * @throws When the lock cannot be acquired before its timeout.
 */
export async function withRefreshLock<T>(configPath: string, task: () => Promise<T>): Promise<T> {
  const credPath = getCredentialsPath(configPath);
  return withFileLock(`${credPath}.refresh.lock`, task, REFRESH_LOCK_OPTIONS);
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
  /**
   * Optional short server description shown to the model in the catalog.
   * The `add` command requires one, but the router accepts entries
   * without it; this type mirrors the raw, unvalidated file.
   */
  description?: string;
  /** Whether the server is enabled. Absent means enabled (default). */
  enabled?: boolean;
  /** Glob patterns allowlisting tool names; empty array means no tools. */
  allowedTools?: string[];
  /** Glob patterns denylisting tool names; wins over allowedTools. */
  disabledTools?: string[];
  /** Optional per-server startup/execution timeout overrides (ms). */
  timeout?: ServerTimeoutInput;
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
    await atomicWriteFile(configPath, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
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
  await atomicWriteFile(configPath, JSON.stringify(existing, null, 2) + '\n');
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
 * Mutates a single server's credentials entry through a fresh
 * read-modify-write executed under the cross-process credentials lock.
 *
 * `mutate` receives the entry currently on disk (or `undefined` when the
 * server has none) and returns:
 * - a replacement entry, written to the store;
 * - `undefined` to delete the entry (and the file when it becomes empty);
 * - the same reference it received to leave the store untouched.
 *
 * Reading inside the lock is what makes concurrent writers safe: a token
 * refresh or auth-requirement update that lands between the caller's
 * earlier read and this call is seen by `mutate` instead of being
 * overwritten by a stale snapshot.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name.
 * @param mutate - Computes the next entry from the current on-disk one.
 * @param logger - Optional logger for permission warnings.
 * @throws If the lock cannot be acquired, the store is unreadable or
 *   invalid, or the write fails.
 */
export async function mutateCredentials(
  configPath: string,
  name: string,
  mutate: (current: StoredCredentials | undefined) => StoredCredentials | undefined,
  logger?: Logger,
): Promise<void> {
  await withCredentialsLock(configPath, async () => {
    const credPath = getCredentialsPath(configPath);
    const store = (await readCredentialsStore(credPath)) ?? {};
    const current = store[name];
    const next = mutate(current);

    if (next === current) {
      // No change requested: skip the write entirely.
      return;
    }
    if (next === undefined) {
      delete store[name];
    } else {
      store[name] = next;
    }

    await writeCredentialsStore(credPath, store, logger);
  });
}

/**
 * Writes (or overwrites) credentials for a single server under the
 * cross-process credentials lock. Preserves credentials for other
 * servers.
 *
 * @internal Exported for tests and the cross-process concurrency
 *   fixture only; production code writes through
 *   {@link mutateCredentials} so it merges against the latest on-disk
 *   entry.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name.
 * @param credentials - The credentials to store.
 * @param logger - Optional logger for permission warnings.
 */
export async function writeCredentials(
  configPath: string,
  name: string,
  credentials: StoredCredentials,
  logger?: Logger,
): Promise<void> {
  await mutateCredentials(configPath, name, () => credentials, logger);
}

/**
 * Replaces the whole credentials store atomically. Deletes the file when
 * the store becomes empty. An existing file keeps its permissions; a new
 * file is restricted to the owner.
 *
 * @param credPath - Absolute path to credentials.json.
 * @param store - The complete store to persist.
 * @param logger - Optional logger for permission warnings.
 */
async function writeCredentialsStore(
  credPath: string,
  store: CredentialsStore,
  logger?: Logger,
): Promise<void> {
  if (Object.keys(store).length === 0) {
    // No entries remain — delete the file entirely. A real failure
    // (e.g. permission denied) must surface: silently leaving removed
    // credentials on disk would defeat logout and `remove`.
    try {
      await fs.unlink(credPath);
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        throw err;
      }
    }
    return;
  }

  const { isNewFile, mode } = await resolveCredentialsMode(credPath);

  // Write atomically (unique temporary sibling + rename): a crash or
  // forced exit can never leave credentials.json truncated, and
  // readCredentials treats invalid JSON as a hard startup error.
  await atomicWriteFile(credPath, JSON.stringify(store, null, 2) + '\n', mode);

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
 * @returns The stored credentials, or undefined when no file exists.
 */
async function readCredentialsStore(credPath: string): Promise<CredentialsStore | undefined> {
  try {
    const raw = await fs.readFile(credPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Credentials file must contain a JSON object: ${credPath}`);
    }
    return parsed as CredentialsStore;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return undefined;
    }
    throw new Error(`Failed to read credentials file for update: ${credPath}`, { cause: err });
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
 * Removes credentials for a server under the cross-process credentials
 * lock. No-op if the server has no stored credentials. Deletes the
 * credentials file when the last entry is removed.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name.
 */
export async function removeCredentials(configPath: string, name: string): Promise<void> {
  await mutateCredentials(configPath, name, () => undefined);
}
