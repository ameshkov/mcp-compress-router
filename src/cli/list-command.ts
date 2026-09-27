import { ensureConfigDir, readConfigFile, readCredentials } from './config-io.js';
import { computeAuthStatus } from '../services/index.js';
import type { AuthStatus, DownstreamServerConfig, ServerTransportType } from '../utils/index.js';

/** A single rendered row in the `list` table. */
interface ServerRow {
  name: string;
  type: string;
  commandOrUrl: string;
  enabled: string;
  tools: string;
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
 * Renders the `Enabled` cell for a server: `yes` unless `enabled` is
 * explicitly `false` (absent = enabled, per PRD §"Assumptions").
 *
 * @param server - Typed downstream server config.
 * @returns `yes` or `no`.
 */
function summarizeEnabled(server: DownstreamServerConfig): string {
  return server.enabled === false ? 'no' : 'yes';
}

/**
 * Renders the configured-filter `Tools` summary cell. Counts configured
 * glob patterns only — never resolved live tool counts. Wording:
 *   - no filtering configured -> `all`
 *   - allowedTools present    -> `<N> allowed`
 *   - disabledTools only      -> `all (<M> blocked)`
 *   - both present            -> `<N> allowed (<M> blocked)`
 *
 * @param server - Typed downstream server config.
 * @returns The compact filter summary.
 */
function summarizeTools(server: DownstreamServerConfig): string {
  const allowed = server.allowedTools;
  const disabled = server.disabledTools;
  if (allowed && disabled) {
    return `${allowed.length} allowed (${disabled.length} blocked)`;
  }
  if (allowed) {
    return `${allowed.length} allowed`;
  }
  if (disabled) {
    return `all (${disabled.length} blocked)`;
  }
  return 'all';
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
  const enabledWidth = Math.max('Enabled'.length, ...rows.map((r) => r.enabled.length));
  const toolsWidth = Math.max('Tools'.length, ...rows.map((r) => r.tools.length));

  const pad = (val: string, width: number): string => val.padEnd(width);
  const columns = (
    name: string,
    type: string,
    command: string,
    enabled: string,
    tools: string,
    auth: string,
  ): string =>
    `${pad(name, nameWidth)}  ${pad(type, typeWidth)}  ${pad(command, commandWidth)}  ${pad(enabled, enabledWidth)}  ${pad(tools, toolsWidth)}  ${auth}`;

  return [
    header,
    '',
    columns('Name', 'Type', 'CommandOrUrl', 'Enabled', 'Tools', 'Auth'),
    ...rows.map((r) => columns(r.name, r.type, r.commandOrUrl, r.enabled, r.tools, r.auth)),
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
      enabled: entry.enabled,
      allowedTools: entry.allowedTools,
      disabledTools: entry.disabledTools,
    };
    return {
      name,
      type: entry.type,
      commandOrUrl: buildCommandOrUrl(typed),
      enabled: summarizeEnabled(typed),
      tools: summarizeTools(typed),
      auth: computeAuthStatus(typed, credentials[name]),
    };
  });

  return formatList(configPath, rows);
}
