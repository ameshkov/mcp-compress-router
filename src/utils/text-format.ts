import type { CatalogServer, ToolDescriptor } from './types.js';
import { extractArgumentNames } from './argument-names.js';
import { LOGIN_INTERACTIVE_NOTE, buildLoginCommand } from './login-guidance.js';

/**
 * Renders the compact catalog as Markdown text suitable for inclusion
 * in the `get_tool_schema` tool description.
 *
 * The catalog is deliberately minimal: every server that advertises at
 * least one tool appears as a single `- name (N tools) - description`
 * bullet, and a degraded server adds an indented status line below its
 * bullet. Servers without tools are not advertised at all. The catalog
 * closes with a list-mode hint that names the first advertised server
 * as the example. Tool names, argument signatures, and tool
 * descriptions are never rendered here; they are one `get_tool_schema`
 * call away (list mode returns the signatures, the schema result
 * returns the complete descriptions).
 *
 * @param servers - The catalog server entries.
 * @returns Compact catalog text, or an empty string when no server
 *   advertises tools.
 */
export function renderCompactCatalog(servers: CatalogServer[]): string {
  const advertised = servers.filter((server) => server.tools.length > 0);
  const firstServer = advertised[0];
  if (!firstServer) {
    return '';
  }
  const blocks = advertised.map((server) => renderServerBlock(server));
  blocks.push('', renderCatalogFooter(firstServer.name));
  return blocks.join('\n');
}

/**
 * Renders the list-mode response for `get_tool_schema`: the server's
 * tool signatures plus a hint to request the full parameter schema.
 *
 * Unlike {@link renderCompactCatalog}, this always renders full
 * signatures (`toolName(arg1, arg2)`): the list is a dynamic tool
 * result, not the static catalog. The status header is included when
 * the server is degraded so the caller knows a cached listing may need
 * authentication or reconnection. A zero-tool server gets a dedicated
 * message instead of the pointless "call again" hint.
 *
 * @param server - The catalog server to render.
 * @returns The list response text.
 */
export function renderToolListResponse(server: CatalogServer): string {
  const statusHeader = renderStatusHeader(server);
  if (server.tools.length === 0) {
    const lines = [`Server "${server.name}" advertises no tools.`];
    if (statusHeader) {
      lines.push(statusHeader);
    }
    return lines.join('\n');
  }

  const lines = [`Tools provided by "${server.name}" (${server.tools.length}):`];
  if (statusHeader) {
    lines.push(statusHeader);
  }
  lines.push('', ...server.tools.map((tool) => renderToolSignature(tool)), '');
  lines.push(
    'Call get_tool_schema with a tool name to get its full description and parameter schema.',
  );
  return lines.join('\n');
}

/**
 * Renders one server's catalog entry: the bullet plus an indented
 * status line when the server is degraded. Callers pass only servers
 * that advertise at least one tool.
 *
 * @param server - The catalog server to render.
 * @returns The server entry text.
 */
function renderServerBlock(server: CatalogServer): string {
  const lines = [renderServerBullet(server)];
  const statusHeader = renderStatusHeader(server);
  if (statusHeader) {
    lines.push(`  ${statusHeader}`);
  }
  return lines.join('\n');
}

/**
 * Renders the single-line bullet for one server:
 * `- name (N tools) - description`. The description is omitted when
 * the server has none.
 *
 * @param server - The catalog server to render.
 * @returns The bullet line.
 */
function renderServerBullet(server: CatalogServer): string {
  const count = server.tools.length;
  const noun = count === 1 ? 'tool' : 'tools';
  const bullet = `- ${server.name} (${count} ${noun})`;
  return server.description ? `${bullet} - ${server.description}` : bullet;
}

/**
 * Renders the trailing list-mode hint, using the first advertised
 * server as the example call.
 *
 * @param firstServer - Name of the first advertised server.
 * @returns The footer line.
 */
function renderCatalogFooter(firstServer: string): string {
  return (
    'Call get_tool_schema with the server name to list all tools, ' +
    `i.e. get_tool_schema(${firstServer})`
  );
}

/**
 * Renders a one-line status header for degraded servers. Returns an
 * empty string for healthy ('ok') servers.
 *
 * The `unauthorized` header hands the login command off to the user
 * through the shared login guidance: the command opens a browser and
 * blocks on interactive authorization, so the agent must not run it
 * itself.
 *
 * @param server - The catalog server to render a status header for.
 * @returns A status line, or empty string when the server is healthy.
 */
function renderStatusHeader(server: CatalogServer): string {
  if (server.status === 'unauthorized') {
    return (
      `Requires authentication. Ask the user to run: ${buildLoginCommand(server.name)}. ` +
      LOGIN_INTERACTIVE_NOTE
    );
  }
  if (server.status === 'unavailable') {
    return 'Server unavailable. Check connectivity and configuration.';
  }
  return '';
}

/**
 * Renders a tool's argument signature: `toolName(arg1, arg2)`.
 *
 * Argument names come from the tool's `inputSchema.properties` keys in
 * definition order; a tool without properties renders as `toolName()`.
 *
 * @internal Exported for tests only; not part of the public module API.
 *   Not re-exported from the barrel — production code calls it through
 *   {@link renderToolListResponse}.
 *
 * @param tool - The tool descriptor.
 * @returns The tool signature.
 */
export function renderToolSignature(tool: ToolDescriptor): string {
  const args = extractArgumentNames(tool.inputSchema);
  return `${tool.name}(${args.join(', ')})`;
}
