import { ensureConfigDir, readConfigFile, writeConfigFile } from './config-io.js';

/**
 * Handles the `enable <name>` subcommand: removes the `enabled` field
 * from a server entry so it defaults to enabled, preserving every other
 * field. Idempotent — if the server is already enabled (field absent or
 * `true`), reports it and makes no change (a stray `true` is normalized
 * away by deletion). Pure config edit; no network access, probe, or login.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name to enable.
 * @returns Human-readable confirmation message.
 * @throws If the server name is not found in mcp.json.
 */
export async function handleEnable(configPath: string, name: string): Promise<string> {
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

  if (servers[name].enabled === undefined || servers[name].enabled === true) {
    // Normalize a stray explicit `true` away so the file stays clean.
    if ('enabled' in servers[name]) {
      delete servers[name].enabled;
      await writeConfigFile(configPath, servers);
    }
    return `Server "${name}" is already enabled.`;
  }

  delete servers[name].enabled;
  await writeConfigFile(configPath, servers);

  return `Enabled server "${name}".`;
}
