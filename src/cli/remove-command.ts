import {
  ensureConfigDir,
  readConfigFile,
  writeConfigFile,
  removeCredentials,
} from './config-io.js';

/**
 * Handles the `remove <name>` subcommand: deletes a server entry
 * and cleans up any stored OAuth credentials for that server.
 *
 * Credentials are removed before the config is rewritten. If cleanup
 * fails, the server stays configured and the command can be retried;
 * the reverse order would drop the server from `mcp.json` while its
 * credentials survive on disk.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name to remove.
 * @returns Human-readable confirmation message to print to stdout.
 * @throws If the server name is not found, or if credentials cleanup
 *   fails (the config is left untouched in that case).
 */
export async function handleRemove(configPath: string, name: string): Promise<string> {
  await ensureConfigDir(configPath);
  const servers = await readConfigFile(configPath);

  if (!(name in servers)) {
    const available = Object.keys(servers);
    const hint =
      available.length > 0
        ? ` Available servers: ${available.join(', ')}`
        : ' No servers configured.';
    throw new Error(`Server "${name}" not found.${hint}`);
  }

  // Clean up any stored OAuth credentials for the removed server first.
  await removeCredentials(configPath, name);

  delete servers[name];
  await writeConfigFile(configPath, servers);

  return `Removed server "${name}".`;
}
