import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/**
 * Creates an HTTP server hosting an MCP fixture server over Streamable
 * HTTP transport. The server listens on a random port.
 *
 * The caller MUST call `server.close()` when done.
 *
 * @returns The HTTP server instance and a function that returns the
 *   last-seen Authorization header value (for header forwarding tests).
 */
export async function createHttpFixtureServer(): Promise<{
  server: http.Server;
  getLastAuthHeader: () => string | undefined;
}> {
  let lastAuthHeader: string | undefined;

  const mcp = new McpServer({
    name: 'test-fixture-http',
    version: '1.0.0',
  });

  mcp.registerTool(
    'echo',
    {
      title: 'Echo Tool',
      description: 'Returns the input message unchanged.',
      inputSchema: {
        message: z.string().describe('The message to echo.'),
      },
    },
    async (params) => {
      return {
        content: [{ type: 'text' as const, text: params.message }],
      };
    },
  );

  mcp.registerTool(
    'add',
    {
      title: 'Add Tool',
      description: 'Adds two numbers together.',
      inputSchema: {
        a: z.number().describe('The first number.'),
        b: z.number().describe('The second number.'),
      },
    },
    async (params) => {
      const result = params.a + params.b;
      return {
        content: [{ type: 'text' as const, text: String(result) }],
      };
    },
  );

  mcp.registerTool(
    'multi_block',
    {
      title: 'Multi-Block Tool',
      description: 'Returns multiple content blocks of different types.',
      inputSchema: {
        prefix: z.string().describe('A prefix for the first text block.'),
      },
    },
    async (params) => {
      return {
        content: [
          { type: 'text' as const, text: `${params.prefix}: first block` },
          {
            type: 'resource' as const,
            resource: {
              uri: 'test://fixture/block-2',
              text: 'second block as resource',
            },
          },
          { type: 'text' as const, text: 'third block' },
        ],
      };
    },
  );

  mcp.registerTool(
    'failing_tool',
    {
      title: 'Failing Tool',
      description: 'Returns an error result with a specific message.',
      inputSchema: {
        message: z.string().describe('The error message to return.'),
      },
    },
    async (params) => {
      return {
        content: [{ type: 'text' as const, text: params.message }],
        isError: true as const,
      };
    },
  );

  mcp.registerTool(
    'check_auth',
    {
      title: 'Check Auth Header',
      description:
        'Returns the last-seen Authorization header captured by the ' +
        'server. Used by E2E tests to verify header forwarding.',
      inputSchema: {},
    },
    async () => {
      return {
        content: [
          {
            type: 'text' as const,
            text: lastAuthHeader ?? '(no Authorization header received)',
          },
        ],
      };
    },
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  await mcp.connect(transport);

  const server = http.createServer(async (req, res) => {
    // Capture the Authorization header for test assertions
    const auth = req.headers.authorization;
    if (auth) {
      lastAuthHeader = auth;
    }

    // Collect body for POST requests
    let body = '';
    if (req.method === 'POST') {
      for await (const chunk of req) {
        body += chunk;
      }
    }

    try {
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500).end('Internal server error');
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      resolve({ server, getLastAuthHeader: () => lastAuthHeader });
    });
    server.on('error', reject);
  });
}
