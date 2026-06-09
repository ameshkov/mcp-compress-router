import {
  ensureConfigDir,
  readConfigFile,
  writeConfigFile,
  type RawServerEntry,
} from './config-io.js';

/**
 * Options for the add subcommand, parsed from CLI flags.
 * @internal — Exported for tests only; not part of the public module API.
 */
export interface AddOptions {
  name: string;
  transport: string;
  commandOrUrl: string;
  /** Additional positional args after commandOrUrl. */
  rest?: string[];
  /** Environment variables from repeated -e flags. */
  env?: Record<string, string>;
  /** HTTP headers from repeated --header flags. */
  headers?: Record<string, string>;
}

/**
 * Handles the `add <name> <commandOrUrl> [args...]` subcommand.
 *
 * - If commandOrUrl starts with http:// or https://, auto-detects as HTTP.
 * - Otherwise treats it as a stdio command.
 * - Writes the entry to the mcpServers object and saves the config file.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param opts - Parsed CLI options.
 * @returns Human-readable confirmation message.
 * @throws If the server name already exists.
 */
export async function handleAdd(configPath: string, opts: AddOptions): Promise<string> {
  await ensureConfigDir(configPath);
  const servers = await readConfigFile(configPath);

  if (opts.name in servers) {
    throw new Error(
      `Server "${opts.name}" already exists. Use "remove ${opts.name}" first to replace it.`,
    );
  }

  // Auto-detect HTTP from URL pattern
  const isUrl = opts.commandOrUrl.startsWith('http://') || opts.commandOrUrl.startsWith('https://');
  const type = isUrl ? 'http' : opts.transport;

  const entry: RawServerEntry = { type };

  if (type === 'http') {
    entry.url = opts.commandOrUrl;
    if (opts.headers && Object.keys(opts.headers).length > 0) {
      entry.headers = opts.headers;
    }
  } else {
    entry.command = opts.commandOrUrl;
    if (opts.rest && opts.rest.length > 0) {
      entry.args = opts.rest;
    }
    if (opts.env && Object.keys(opts.env).length > 0) {
      entry.env = opts.env;
    }
  }

  servers[opts.name] = entry;
  await writeConfigFile(configPath, servers);

  let result = `Added server "${opts.name}" (${type}).`;

  // Attempt OAuth detection for HTTP servers (best-effort, non-blocking)
  if (type === 'http') {
    try {
      const { loadConfig } = await import('../services/config.js');
      const allConfigs = await loadConfig(configPath);
      const newServer = allConfigs.find((s) => s.name === opts.name);
      if (newServer) {
        // Quick connection to check if server requires auth
        const { connectAndDiscover } = await import('../services/discovery.js');
        const { Logger } = await import('../utils/index.js');
        try {
          await connectAndDiscover([newServer], new Logger('error'));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('auth')) {
            result += `\nServer "${opts.name}" requires authentication. Run:\n  mcp-compress-router login ${opts.name}`;
          }
        }
      }
    } catch {
      // Best-effort detection — don't block add on detection failure
    }
  }

  return result;
}
