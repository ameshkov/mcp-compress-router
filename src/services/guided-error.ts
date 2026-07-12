import type { DownstreamServerConfig, ServerStatus } from '../utils/index.js';

/**
 * Builds a detailed, multi-line error message for an unavailable
 * downstream server, explaining what happened, showing the underlying
 * error, and giving actionable steps including the restart fallback.
 *
 * The message format is:
 *
 * 1. Summary line: server name + what went wrong.
 * 2. "What happened:" section.
 * 3. "Underlying error:" — the original error message verbatim.
 * 4. "To fix this:" — numbered, actionable steps tailored to the
 *    server type and status.
 * 5. Restart fallback guidance.
 *
 * @param server - The downstream server configuration.
 * @param underlyingError - The original error that caused the failure.
 * @param status - The server's current status.
 * @param recoveryAttempted - Whether automatic recovery was tried and
 *   failed. When true, an additional note is included.
 * @returns An `Error` with the detailed message.
 */
export function buildGuidedError(
  server: DownstreamServerConfig,
  underlyingError: unknown,
  status: ServerStatus,
  recoveryAttempted: boolean,
): Error {
  const underlyingMessage = extractMessage(underlyingError);
  const isStdio = server.type === 'stdio';
  const isAuth = status === 'unauthorized';

  const lines: string[] = [];

  lines.push(`Server "${server.name}" is unavailable: ${headline(server, status)}.`);
  lines.push('');
  lines.push('What happened:');
  lines.push(bodyText(server, status, isStdio, isAuth));
  lines.push('');
  lines.push(`Underlying error: ${underlyingMessage}`);
  if (recoveryAttempted) {
    lines.push('');
    lines.push('Automatic recovery was attempted but failed.');
  }
  lines.push('');
  lines.push('To fix this:');
  lines.push(...fixSteps(server, status, isStdio, isAuth));
  lines.push('');
  lines.push(restartGuidance(isStdio));

  return new Error(lines.join('\n'));
}

function headline(server: DownstreamServerConfig, status: ServerStatus): string {
  if (status === 'unauthorized') {
    return 'authentication is required';
  }
  if (server.type === 'stdio') {
    return 'the downstream process could not start';
  }
  return 'connection failed';
}

function bodyText(
  server: DownstreamServerConfig,
  status: ServerStatus,
  isStdio: boolean,
  isAuth: boolean,
): string {
  if (isAuth) {
    return (
      `The router could not connect to server "${server.name}" because ` +
      `authentication is required or the stored credentials are invalid.`
    );
  }
  if (isStdio) {
    return (
      `The router could not start server "${server.name}" because the ` +
      `configured command failed to spawn or connect.`
    );
  }
  return `The router could not establish a connection to server "${server.name}".`;
}

function fixSteps(
  server: DownstreamServerConfig,
  status: ServerStatus,
  isStdio: boolean,
  isAuth: boolean,
): string[] {
  if (isAuth) {
    return [
      `1. Run:  npx mcp-compress-router login ${server.name}`,
      '2. Complete the browser authorization flow.',
      '3. Try your request again — the router will automatically pick up the',
      '   new credentials and reconnect.',
    ];
  }
  if (isStdio) {
    const cmd = server.command ?? '(unknown)';
    return [
      `1. Verify the command is installed: ${cmd}`,
      '2. Check that the command is in your PATH.',
      '3. If using npx, ensure the package is available.',
      '4. If the configuration has changed, update mcp.json.',
    ];
  }
  return [
    '1. Verify the server is running and reachable.',
    '2. Check your network connection and configuration.',
    '3. If the configuration has changed, update mcp.json.',
    '',
    'After fixing, try your request again — the router will attempt to',
    'reconnect automatically.',
  ];
}

function restartGuidance(isStdio: boolean): string {
  const restartClause = isStdio
    ? 'Stdio servers cannot self-recover without a restart because the ' +
      'process must be spawned anew.'
    : 'If the issue persists, restart the MCP server in your coding agent.';
  return (
    restartClause +
    ' If you have already fixed the issue, restart the MCP server in your ' +
    'coding agent (e.g. restart Claude Code, opencode, or Codex) so it ' +
    're-initializes the connection.'
  );
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
