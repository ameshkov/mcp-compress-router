import {
  ensureConfigDir,
  readConfigFile,
  readCredentials,
  removeCredentials,
} from './config-io.js';

/**
 * Handles the `logout <name>` subcommand.
 *
 * Removes the server's whole entry from credentials.json: tokens, the
 * dynamic client registration, the server and issuer bindings, and the
 * cached auth requirement. The credentials file is deleted when no
 * entries remain. Tokens are not revoked at the authorization server;
 * this is a local sign-out. The server stays in mcp.json.
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

  // Local sign-out only: remove the stored credentials. Tokens are not
  // revoked at the authorization server; the provider expires them.
  await removeCredentials(configPath, name);

  return `Removed credentials for server "${name}".`;
}
