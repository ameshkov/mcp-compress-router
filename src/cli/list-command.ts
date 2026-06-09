import { ensureConfigDir, readConfigFile } from './config-io.js';

/**
 * Handles the `list` subcommand: prints all configured servers.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @returns Human-readable output to print to stdout.
 */
export async function handleList(configPath: string): Promise<string> {
  await ensureConfigDir(configPath);
  const servers = await readConfigFile(configPath);

  const names = Object.keys(servers);
  if (names.length === 0) {
    return '';
  }

  const lines = names.map((name) => {
    const entry = servers[name];
    const desc = entry.description ? ` — ${entry.description}` : '';
    return `${name} (${entry.type})${desc}`;
  });

  return lines.join('\n');
}
