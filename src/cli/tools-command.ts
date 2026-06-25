import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { DownstreamServerConfig } from '../utils/index.js';
import { Logger } from '../utils/index.js';
import {
  discoverSingleServer,
  persistAuthRequirements,
  loadConfig,
  OAuthCredentialManager,
} from '../services/index.js';
import { filterTools, type ToolExposureEntry } from '../utils/index.js';
import { ensureConfigDir } from './config-io.js';

/** Maximum width of the description column before truncation. */
const DESCRIPTION_MAX_WIDTH = 60;

/**
 * Truncates a description to {@link DESCRIPTION_MAX_WIDTH} characters,
 * appending an ellipsis when truncated. Returns an empty string for
 * undefined input.
 */
function truncateDescription(desc: string | undefined): string {
  if (!desc) return '';
  if (desc.length <= DESCRIPTION_MAX_WIDTH) return desc;
  return desc.slice(0, DESCRIPTION_MAX_WIDTH - 1) + '…';
}

/**
 * Renders the tools table from the filter result.
 *
 * Columns: Name (padded), Description (padded, truncated), Exposure
 * (unpadded to avoid trailing whitespace). Mirrors the layout style of
 * `list-command.ts`.
 */
function renderToolsTable(serverName: string, entries: ToolExposureEntry[]): string {
  const header = `Tools exposed by "${serverName}":`;
  if (entries.length === 0) {
    return `${header}\n(server advertises no tools)`;
  }

  const nameWidth = Math.max('Name'.length, ...entries.map((e) => e.descriptor.name.length));
  const descWidth = Math.max(
    'Description'.length,
    ...entries.map((e) => truncateDescription(e.descriptor.description).length),
  );

  const pad = (val: string, width: number): string => val.padEnd(width);
  const row = (name: string, desc: string, exposure: string): string =>
    `${pad(name, nameWidth)}  ${pad(desc, descWidth)}  ${exposure}`;

  return [
    header,
    '',
    row('Name', 'Description', 'Exposure'),
    ...entries.map((e) =>
      row(
        e.descriptor.name,
        truncateDescription(e.descriptor.description),
        e.decision === 'exposed' ? '[exposed]' : '[filtered]',
      ),
    ),
  ].join('\n');
}

/**
 * Builds a `getAuthProvider` callback for a single server, returning
 * an `OAuthCredentialManager` when the server is HTTP and has either
 * stored tokens or oauth overrides configured. Mirrors the gate in
 * `register-commands.ts` `buildAuthProviders`, scoped to one server.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param server - Target downstream server config.
 * @returns A callback returning the provider, or undefined.
 */
async function buildSingleAuthProvider(
  configPath: string,
  server: DownstreamServerConfig,
): Promise<(s: DownstreamServerConfig) => OAuthClientProvider | undefined> {
  if (server.type !== 'http' && server.type !== 'streamable-http') {
    return () => undefined;
  }
  const mgr = new OAuthCredentialManager(configPath, server);
  const hasCredentials = (await mgr.tokens()) !== undefined;
  const hasOverrides = server.oauth?.clientId !== undefined;
  if (!hasCredentials && !hasOverrides) {
    return () => undefined;
  }
  return (queried) => (queried.name === server.name ? mgr : undefined);
}

/**
 * Handles the `tools <name>` subcommand: connects to the named
 * downstream server *live* (regardless of its `enabled` state), lists
 * every tool it advertises, applies the Tool Filter to mark each tool
 * `[exposed]` or `[filtered]` against the server's configured
 * `allowedTools`/`disabledTools`, and renders a readable table.
 *
 * For HTTP servers the cached OAuth `authRequirement` is refreshed
 * before connecting (consistent with `add`), and stored OAuth
 * credentials / oauth overrides are reused for the transport.
 *
 * @param configPath - Absolute path to the mcp.json file.
 * @param name - Server name to inspect.
 * @returns Human-readable table to print to stdout.
 * @throws If the server is not found, unreachable, or advertises no
 *   tools and the user-facing contract requires an error.
 */
export async function handleTools(configPath: string, name: string): Promise<string> {
  await ensureConfigDir(configPath);
  const servers = await loadConfig(configPath);

  const target = servers.find((s) => s.name === name);
  if (!target) {
    const available = servers.map((s) => s.name);
    const hint =
      available.length > 0
        ? ` Available servers: ${available.join(', ')}`
        : ' No servers configured.';
    throw new Error(`Server "${name}" not found.${hint}`);
  }

  const logger = new Logger(process.env.MCP_COMPRESS_ROUTER_VERBOSE === 'true' ? 'debug' : 'info');

  // Refresh cached auth requirement for HTTP servers (Open Question 1:
  // yes, for consistency with `add`). stdio servers short-circuit inside
  // persistAuthRequirements and do no network access.
  if (target.type !== 'stdio') {
    await persistAuthRequirements(configPath, [target], logger);
  }

  const getAuthProvider = await buildSingleAuthProvider(configPath, target);

  const discovered = await discoverSingleServer(target, logger, getAuthProvider);
  const filterResult = filterTools(discovered.tools, target.allowedTools, target.disabledTools);

  if (filterResult.unmatchedPatterns.length > 0) {
    logger.info(`Unmatched selection patterns for "${name}"`, {
      patterns: filterResult.unmatchedPatterns,
    });
  }

  return renderToolsTable(name, filterResult.entries);
}
