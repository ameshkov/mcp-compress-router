import { spawn } from 'node:child_process';

/**
 * Opens a URL in the default browser using the platform-native command.
 * Uses `spawn()` with separated arguments to prevent shell injection.
 *
 * @param url - The URL to open.
 * @public
 */
export async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;

  return new Promise<void>((resolve, reject) => {
    let child;

    if (platform === 'darwin') {
      child = spawn('open', [url]);
    } else if (platform === 'win32') {
      // `start` is a shell built-in, so shell: true is unavoidable on Windows.
      // No user-controlled string is interpolated into the command template.
      child = spawn('start', ['""', url], { shell: true });
    } else {
      child = spawn('xdg-open', [url]);
    }

    child.on('error', reject);
    // The browser process is fire-and-forget; resolve as soon as spawn succeeds
    child.on('spawn', () => resolve());
  });
}
