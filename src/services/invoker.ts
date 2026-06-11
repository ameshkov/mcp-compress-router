import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Logger } from '../utils/index.js';

/**
 * Checks whether an error message indicates an authentication failure.
 *
 * @param message - The error message string to inspect.
 * @returns `true` when the message contains an auth-related keyword.
 */
function isAuthError(message: string): boolean {
  return (
    message.includes('Unauthorized') || message.includes('unauthorized') || message.includes('auth')
  );
}

/**
 * Looks up a downstream MCP client by server name.
 *
 * @param clients - Map of server name to live MCP client.
 * @param serverName - The downstream server name.
 * @param logger - Structured logger for diagnostic output.
 * @returns The matching client.
 * @throws When no client is registered for the given server name.
 */
function getClient(clients: Map<string, Client>, serverName: string, logger: Logger): Client {
  const client = clients.get(serverName);
  if (!client) {
    logger.error('Downstream server not found for invocation', {
      server: serverName,
      availableServers: [...clients.keys()],
    });
    throw new Error(
      `Server "${serverName}" not found. Available servers: ${[...clients.keys()].join(', ')}`,
    );
  }
  return client;
}

/**
 * Invokes a tool on a downstream MCP server and returns the result
 * verbatim.
 *
 * @param clients - Map of server name to live MCP client.
 * @param serverName - The downstream server name.
 * @param toolName - The tool to invoke.
 * @param args - The arguments to pass to the tool.
 * @param logger - Structured logger for diagnostic output.
 * @returns The downstream call result verbatim (content blocks
 *   unchanged in structure and order).
 */
export async function invokeDownstreamTool(
  clients: Map<string, Client>,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  logger: Logger,
): Promise<{ content: Array<Record<string, unknown>>; isError?: boolean; [key: string]: unknown }> {
  logger.debug('Forwarding invocation to downstream server', {
    server: serverName,
    tool: toolName,
    arguments: args,
  });

  const client = getClient(clients, serverName, logger);

  try {
    const result = (await client.callTool({ name: toolName, arguments: args })) as {
      content: Array<Record<string, unknown>>;
      isError?: boolean;
      [key: string]: unknown;
    };

    logger.debug('Downstream invocation result', {
      server: serverName,
      tool: toolName,
      isError: result.isError ?? false,
      contentBlockCount: result.content.length,
    });

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAuthError(message)) {
      logger.error('Downstream server authentication failed', {
        server: serverName,
        tool: toolName,
        error: message,
      });
      throw new Error(
        `Authentication failed for server "${serverName}". ` +
          `Run "mcp-compress-router login ${serverName}" to re-authenticate.`,
      );
    }
    throw err;
  }
}
