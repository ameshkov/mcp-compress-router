import { ensureConfigDir, readConfigFile, writeConfigFile } from './config-io.js';

/**
 * Handles the `disable <name>` subcommand: sets `enabled: false` on a
 * server entry, preserving every other field. Idempotent — if the server
 * is already disabled, reports it and makes no change. Pure config edit;
 * no network access, probe, or login.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name to disable.
 * @returns Human-readable confirmation message.
 * @throws If the server name is not found in mcp.json.
 */
export async function handleDisable(configPath: string, name: string): Promise<string> {
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

  if (servers[name].enabled === false) {
    return `Server "${name}" is already disabled.`;
  }

  servers[name].enabled = false;
  await writeConfigFile(configPath, servers);

  return `Disabled server "${name}".`;
}
