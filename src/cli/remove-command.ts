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
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name to remove.
 * @returns Human-readable confirmation message to print to stdout.
 * @throws If the server name is not found.
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

  delete servers[name];
  await writeConfigFile(configPath, servers);

  // Clean up any stored OAuth credentials for the removed server.
  await removeCredentials(configPath, name);

  return `Removed server "${name}".`;
}
