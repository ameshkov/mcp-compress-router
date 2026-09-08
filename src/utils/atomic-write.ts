import * as fs from 'node:fs/promises';

/**
 * Writes a file atomically: writes the content to a unique temporary
 * file in the same directory, then renames it over the target. Rename is
 * atomic on POSIX (and on modern Windows via `MoveFileEx`), so a reader
 * or a concurrent writer from another process can only ever observe the
 * old complete content or the new complete content — never a torn file.
 * The temporary file is removed when the write fails.
 *
 * The optional `mode` is applied to the temporary file (the rename
 * preserves it), so callers can keep a sensitive file's permissions —
 * e.g. `credentials.json` must stay owner-only even across rewrites.
 *
 * @param filePath - Absolute path to the destination file.
 * @param content - The full content to write.
 * @param mode - File mode for the write (e.g. `0o600`). Omitted when
 *   the default umask-based mode is fine.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
  mode?: number,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, content, mode !== undefined ? { mode } : undefined);
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}
