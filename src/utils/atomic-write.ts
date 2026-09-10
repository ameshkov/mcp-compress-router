import * as fs from 'node:fs/promises';

/**
 * Writes a file atomically: the content is first written to a unique
 * temporary sibling file, then renamed over the target. Renaming within
 * the same directory is atomic on POSIX, so a reader or a concurrent
 * writer can only ever observe the old complete file or the new complete
 * file — never a torn or empty one. The temporary file is removed when
 * the write or the rename fails.
 *
 * The optional `mode` is applied to the temporary file (the rename
 * preserves it), so callers can keep a sensitive file's permissions —
 * e.g. `credentials.json` must stay owner-only across rewrites.
 *
 * @param filePath - Absolute path to the destination file.
 * @param content - The full content to write.
 * @param mode - Optional file mode (e.g. `0o600`); omitted to use the
 *   default umask-based mode.
 * @throws If writing the temporary file or renaming it over the target
 *   fails. The temporary file is removed before the error propagates.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
  mode?: number,
): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.writeFile(tempPath, content, mode !== undefined ? { mode } : undefined);
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}
