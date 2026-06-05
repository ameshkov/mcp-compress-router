import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { DownstreamServerConfig, ToolDescriptor } from '../utils/index.js';

/**
 * Result of connecting to and discovering tools from a downstream server.
 */
export interface DiscoveredServer {
  /** The server name (from config). */
  name: string;
  /** The server's optional description. */
  description?: string;
  /** Discovered tool descriptors. */
  tools: ToolDescriptor[];
}

/**
 * Connects to all configured stdio servers in parallel and discovers
 * their tools. Fails fast if any server is unreachable.
 *
 * @param servers - Validated downstream server configs.
 * @returns Discovered server data for each server.
 * @throws If any server cannot be connected or tools cannot be listed.
 */
export async function connectAndDiscover(
  servers: DownstreamServerConfig[],
): Promise<DiscoveredServer[]> {
  const results = await Promise.all(
    servers.map(async (server) => {
      const client = new Client(
        { name: 'mcp-compress-router', version: '1.0.0' },
        { capabilities: {} },
      );

      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: server.env,
      });

      try {
        await client.connect(transport);
        const listResult = await client.listTools();

        const tools: ToolDescriptor[] = listResult.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
        }));

        return {
          name: server.name,
          description: server.description,
          tools,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to connect to server "${server.name}": ${message}`);
      }
    }),
  );

  return results;
}
