import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteFile, type ToolDescriptor } from '../utils/index.js';

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
 * Sanitizes a parsed cache store: keeps only entries that are plain
 * objects carrying a `tools` array, and drops everything else. A cache
 * file that is damaged in parts therefore degrades to the subset of
 * still-valid entries instead of being rejected wholesale; a root that
 * is not a plain object degrades to an empty store.
 *
 * @param parsed - The raw JSON.parse() result of the cache file.
 * @returns A validated store containing only well-formed entries.
 */
function sanitizeStore(parsed: unknown): ToolCacheStore {
  const store: ToolCacheStore = {};
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return store;
  }
  for (const [serverName, entry] of Object.entries(parsed)) {
    const candidate = entry as CachedToolEntry | null;
    if (candidate !== null && typeof candidate === 'object' && Array.isArray(candidate.tools)) {
      store[serverName] = candidate;
    }
  }
  return store;
}

/**
 * Reads the full tool cache store from disk. Returns an empty object
 * when the file does not exist. A corrupted cache file (invalid JSON,
 * a non-object root, or entries without a `tools` array) never throws:
 * it is treated as empty or partially empty so a damaged cache can
 * never break the router. The next write simply rebuilds the file.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @returns The tool cache store (possibly empty or partial).
 * @throws Only on unexpected I/O errors (e.g. permission denied).
 */
async function readCacheStore(configPath: string): Promise<ToolCacheStore> {
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
  try {
    return sanitizeStore(JSON.parse(raw));
  } catch {
    // Invalid JSON: treat the whole cache as empty rather than throwing.
    // loadToolCache reports "no cache" and saveToolCache rebuilds it.
    return {};
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
 */
export async function saveToolCache(
  configPath: string,
  serverName: string,
  tools: ToolDescriptor[],
): Promise<void> {
  const cachePath = getCachePath(configPath);
  await serializeCacheWrite(cachePath, async () => {
    const store = await readCacheStore(configPath);
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
 * server's entry has no tools array.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param serverName - The server whose cached tools to load.
 * @returns The cached tool descriptors, or `undefined` when not cached
 *   (including when the cache file is missing or corrupted).
 */
export async function loadToolCache(
  configPath: string,
  serverName: string,
): Promise<ToolDescriptor[] | undefined> {
  const store = await readCacheStore(configPath);
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
