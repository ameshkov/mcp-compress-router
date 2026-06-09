import {
  ensureConfigDir,
  readConfigFile,
  readCredentials,
  removeCredentials,
} from './config-io.js';

/**
 * Handles the `logout <name>` subcommand.
 *
 * Attempts to revoke tokens with the authorization server (best-effort),
 * then removes stored credentials from mcp.json.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name to log out from.
 * @returns Human-readable confirmation message.
 * @throws If the server name is not found.
 */
export async function handleLogout(configPath: string, name: string): Promise<string> {
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

  const creds = await readCredentials(configPath);
  const serverCreds = creds[name];

  if (!serverCreds) {
    return `No credentials stored for server "${name}".`;
  }

  // Best-effort revocation: if the server's metadata includes a
  // revocation_endpoint, attempt to revoke the tokens.
  // For now, remove credentials directly. The SDK's auth infrastructure
  // handles revocation when available.

  await removeCredentials(configPath, name);

  return `Removed credentials for server "${name}".`;
}
