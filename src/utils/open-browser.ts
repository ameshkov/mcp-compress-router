import { spawn, type SpawnOptions } from 'node:child_process';

/**
 * Splits a command line into executable + arguments, honoring shell-style
 * quoting so paths with spaces work. Supports single and double quotes;
 * no escape sequences (environment overrides never need them).
 *
 * @param input - The command line to split.
 * @returns The program and its pre-set arguments.
 */
function splitCommandLine(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (const char of input) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ' ' || char === '\t') {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

/**
 * Opens a URL in the default browser using the platform-native command.
 *
 * The browser command can be overridden with the
 * `MCP_COMPRESS_ROUTER_BROWSER` environment variable. Set it to the
 * executable plus any preset arguments (e.g.
 * `node "/path/with spaces/headless-browser.js" --flag`); the URL is always
 * appended as a single, final argument. No shell is used, so there is no
 * shell-injection risk — this also makes the override safe to drive OAuth
 * flows in headless and CI environments.
 *
 * @param url - The URL to open.
 */
export async function openBrowser(url: string): Promise<void> {
  const customBrowser = process.env.MCP_COMPRESS_ROUTER_BROWSER;
  if (customBrowser && customBrowser.trim().length > 0) {
    const [command, ...presetArgs] = splitCommandLine(customBrowser.trim());
    return spawnBrowser(command, [...presetArgs, url]);
  }

  const platform = process.platform;
  if (platform === 'darwin') {
    return spawnBrowser('open', [url]);
  }
  if (platform === 'win32') {
    // `start` is a shell built-in, so shell: true is unavoidable on Windows.
    // No user-controlled string is interpolated into the command template.
    return spawnBrowser('start', ['""', url], { shell: true });
  }
  return spawnBrowser('xdg-open', [url]);
}

/**
 * Spawns a browser command and resolves once it has spawned.
 *
 * The browser process is fire-and-forget; this only waits for a successful
 * spawn, not for the process to exit.
 *
 * @param command - The executable to run.
 * @param args - Arguments to pass to the executable (including the URL).
 * @param options - Optional spawn options (e.g. `shell: true` on Windows).
 * @throws If the process fails to spawn.
 */
function spawnBrowser(command: string, args: string[], options?: SpawnOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = options ? spawn(command, args, options) : spawn(command, args);
    child.on('error', reject);
    child.on('spawn', () => resolve());
  });
}
