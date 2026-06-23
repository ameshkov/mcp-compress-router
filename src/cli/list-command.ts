import { ensureConfigDir, readConfigFile, readCredentials } from './config-io.js';
import { computeAuthStatus } from '../services/index.js';
import type { AuthStatus, DownstreamServerConfig, ServerTransportType } from '../utils/index.js';

/** A single rendered row in the `list` table. */
interface ServerRow {
  name: string;
  type: string;
  commandOrUrl: string;
  auth: AuthStatus;
}

/**
 * Builds the display string for the command (stdio) or URL (http)
 * column of a server row.
 *
 * @param server - Typed downstream server config.
 * @returns The command plus args, or the URL.
 */
function buildCommandOrUrl(server: DownstreamServerConfig): string {
  if (server.type === 'stdio') {
    const parts: string[] = [];
    if (server.command) {
      parts.push(server.command);
    }
    if (server.args?.length) {
      parts.push(...server.args);
    }
    return parts.join(' ');
  }
  return server.url ?? '';
}

/**
 * Renders the list header and server rows as a fixed-width table. The
 * final (Auth) column is left unpadded so lines never carry trailing
 * whitespace.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param rows - Prepared server rows.
 * @returns The formatted table as a single string.
 */
function formatList(configPath: string, rows: ServerRow[]): string {
  const header = `Configuration was loaded from ${configPath}`;
  if (rows.length === 0) {
    return header;
  }

  const nameWidth = Math.max('Name'.length, ...rows.map((r) => r.name.length));
  const typeWidth = Math.max('Type'.length, ...rows.map((r) => r.type.length));
  const commandWidth = Math.max('CommandOrUrl'.length, ...rows.map((r) => r.commandOrUrl.length));

  const pad = (val: string, width: number): string => val.padEnd(width);
  const columns = (name: string, type: string, command: string, auth: string): string =>
    `${pad(name, nameWidth)}  ${pad(type, typeWidth)}  ${pad(command, commandWidth)}  ${auth}`;

  return [
    header,
    '',
    columns('Name', 'Type', 'CommandOrUrl', 'Auth'),
    ...rows.map((r) => columns(r.name, r.type, r.commandOrUrl, r.auth)),
  ].join('\n');
}

/**
 * Handles the `list` subcommand: prints the configuration file that was
 * loaded followed by a table of every configured server and its auth
 * status. Reads only local files (`mcp.json` and `credentials.json`) —
 * no network access.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @returns Human-readable output to print to stdout.
 */
export async function handleList(configPath: string): Promise<string> {
  await ensureConfigDir(configPath);
  const servers = await readConfigFile(configPath);
  const credentials = await readCredentials(configPath);

  const rows: ServerRow[] = Object.entries(servers).map(([name, entry]) => {
    const typed: DownstreamServerConfig = {
      name,
      type: entry.type as ServerTransportType,
      command: entry.command,
      args: entry.args,
      url: entry.url,
      headers: entry.headers,
    };
    return {
      name,
      type: entry.type,
      commandOrUrl: buildCommandOrUrl(typed),
      auth: computeAuthStatus(typed, credentials[name]),
    };
  });

  return formatList(configPath, rows);
}
