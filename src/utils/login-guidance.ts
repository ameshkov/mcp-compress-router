/**
 * Builds the `login` command a user runs to authorize a downstream
 * OAuth server.
 *
 * Shared by the catalog status header and the guided error so both
 * agent-facing surfaces name the same command.
 *
 * @param serverName - The downstream server name.
 * @returns The command that starts the interactive login flow.
 */
export function buildLoginCommand(serverName: string): string {
  return `npx mcp-compress-router login ${serverName}`;
}

/**
 * Explains why the login command must be handed to the user: it opens a
 * browser and blocks on an interactive authorization flow the agent
 * cannot complete.
 *
 * Embedded verbatim by the catalog status header (`text-format.ts`) and
 * the guided error (`guided-error.ts`) so the two agent-facing surfaces
 * cannot drift apart.
 */
export const LOGIN_INTERACTIVE_NOTE =
  'This opens a browser for interactive authorization. Do not run it yourself.';
