import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger, ToolDescriptor } from '../utils/index.js';

/**
 * Shape of a single server's cached tool entry in `tools-cache.json`.
 */
interface CachedToolEntry {
  /** The tool descriptors discovered at the time of caching. */
  tools: ToolDescriptor[];
  /** ISO-8601 timestamp of when the cache was written. Debugging only —
   *  no TTL or expiry is enforced in v1. */
  cachedAt: string;
}

/**
 * The full cache file shape, keyed by server name.
 */
type ToolCacheStore = Record<string, CachedToolEntry>;

/**
 * Per-cache-file write queues. Each value is the promise of the most
 * recently queued write for that file. New writes chain onto it so all
 * read-modify-write operations against the same `tools-cache.json` run
 * strictly one at a time, even when many servers connect in parallel.
 *
 * Without serialization, concurrent `saveToolCache` calls (one per
 * parallel `connect()` at startup) race on the shared file: each reads
 * the pre-existing store, mutates its own key, and writes the whole file
 * back — so only the last writer's entry survives and the others are
 * silently lost. The queue keys by cache path (not config path) so a
 * single process-wide mutex guards each file.
 *
 * The queue only serializes writers within one process. Multiple router
 * instances (e.g. several coding-agent sessions spawning the router
 * simultaneously) still race on the same file, so `atomicWriteFile`
 * (temp-file + rename) guarantees readers never observe a torn file and
 * `readCacheStore` tolerates any file that ends up corrupted anyway.
 */
const writeQueues = new Map<string, Promise<void>>();

/**
 * Derives the tool cache file path from the config path. The cache
 * file is stored as `tools-cache.json` in the same directory as
 * `mcp.json`, alongside `credentials.json`.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @returns Absolute path to tools-cache.json.
 */
function getCachePath(configPath: string): string {
  return path.join(path.dirname(configPath), 'tools-cache.json');
}

/**
 * Runs a read-modify-write `task` against a cache file strictly after
 * any previously queued write for the same file. Resolves/rejects with
 * the task's own result so callers still observe the real outcome. A
 * failed task never poisons the queue — the next write still runs.
 *
 * @param cachePath - Absolute path to the cache file (the lock key).
 * @param task - The async read-modify-write operation to run.
 * @returns The task's result, once it has run in turn.
 */
function serializeCacheWrite<T>(cachePath: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(cachePath) ?? Promise.resolve();
  const result = previous.then(task, task);
  writeQueues.set(
    cachePath,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/**
 * Type guard for Node.js system errors that carry a `code` property.
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

/**
 * Reads the full tool cache store from disk. Returns an empty object
 * when the file does not exist or when its content is unusable
 * (invalid JSON, an empty file, or a non-object value) — the cache is
 * disposable and gets rebuilt on the next successful `listTools()`, so
 * a file corrupted by a crash, a kill mid-write, or concurrent writers
 * must not break startup. A warning is logged when a logger is provided.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param logger - Optional logger; corruption is logged as a warning.
 * @returns The tool cache store, or empty object when the file is
 *   missing or unusable.
 * @throws If the file exists but cannot be read (e.g. permissions).
 */
async function readCacheStore(configPath: string, logger?: Logger): Promise<ToolCacheStore> {
  const cachePath = getCachePath(configPath);
  let raw: string;
  try {
    raw = await fs.readFile(cachePath, 'utf-8');
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return {};
    }
    throw new Error(`Failed to read tool cache file: ${cachePath}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger?.warn(`Tool cache file contains invalid JSON, ignoring it: ${cachePath}`);
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger?.warn(`Tool cache file does not contain a JSON object, ignoring it: ${cachePath}`);
    return {};
  }
  return parsed as ToolCacheStore;
}

/**
 * Writes a file atomically: writes the content to a unique temporary
 * file in the same directory, then renames it over the target. Rename is
 * atomic on POSIX (and on modern Windows via `MoveFileEx`), so a reader
 * or a concurrent writer from another process can only ever observe the
 * old complete content or the new complete content — never a torn file.
 * The temporary file is removed when the write fails.
 *
 * @param filePath - Absolute path to the destination file.
 * @param content - The full content to write.
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

/**
 * Saves discovered tools to the on-disk tool cache for a single server.
 * Preserves other servers' cached entries. Overwrites the entry for the
 * given server if it already exists. The cache is written immediately
 * after every successful `listTools()` call so it is always fresh-of-
 * last-success.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param serverName - The server whose tools to cache.
 * @param tools - The discovered tool descriptors.
 * @param logger - Optional logger; a corrupt existing cache is logged.
 */
export async function saveToolCache(
  configPath: string,
  serverName: string,
  tools: ToolDescriptor[],
  logger?: Logger,
): Promise<void> {
  const cachePath = getCachePath(configPath);
  await serializeCacheWrite(cachePath, async () => {
    const store = await readCacheStore(configPath, logger);
    store[serverName] = {
      tools,
      cachedAt: new Date().toISOString(),
    };
    await atomicWriteFile(cachePath, JSON.stringify(store, null, 2) + '\n');
  });
}

/**
 * Loads cached tools for a single server from disk. Returns `undefined`
 * when the file does not exist, the server is not in the cache, or the
 * server's entry has no tools array. A corrupt cache file is treated as
 * "not cached" (with a logged warning) instead of throwing — the cache
 * is disposable and rebuilt on the next successful connect.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param serverName - The server whose cached tools to load.
 * @param logger - Optional logger; a corrupt cache file is logged.
 * @returns The cached tool descriptors, or `undefined` when not cached.
 */
export async function loadToolCache(
  configPath: string,
  serverName: string,
  logger?: Logger,
): Promise<ToolDescriptor[] | undefined> {
  const store = await readCacheStore(configPath, logger);
  const entry = store[serverName];
  if (!entry || !Array.isArray(entry.tools)) {
    return undefined;
  }
  return entry.tools as ToolDescriptor[];
}

/**
 * Removes a single server from the on-disk tool cache. Deletes the
 * entire cache file when the last entry is removed. No-op when the
 * file or server does not exist.
 *
 * @internal Exported for tests only; not part of the public module API.
 *   No production consumer — kept so tests can invalidate cached
 *   schemas.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param serverName - The server whose cache entry to remove.
 */
export async function clearToolCache(configPath: string, serverName: string): Promise<void> {
  const cachePath = getCachePath(configPath);
  await serializeCacheWrite(cachePath, async () => {
    const store = await readCacheStore(configPath);
    if (!(serverName in store)) {
      return;
    }
    delete store[serverName];
    if (Object.keys(store).length === 0) {
      await fs.unlink(cachePath).catch(() => {});
    } else {
      await atomicWriteFile(cachePath, JSON.stringify(store, null, 2) + '\n');
    }
  });
}
