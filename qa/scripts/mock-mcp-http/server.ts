#!/usr/bin/env node
/**
 * Mock MCP server for manual QA testing (streamable-http transport).
 *
 * Runs as its own container in the QA compose stack so a scenario can
 * add a remote downstream server over the network. With
 * `MOCK_MCP_AUTH=oauth` it also exposes a mock OAuth 2.1 authorization
 * server and requires a bearer token on `/mcp`, which lets the plans
 * exercise `login`, token storage, and authenticated tool calls
 * end-to-end.
 *
 * Tools (shared with the stdio mock):
 * - `echo(message)` — returns `echo: <message>`.
 * - `add(a, b)` — returns the sum of two numbers.
 * - `multi_block(prefix)` — returns three content blocks.
 * - `failing_tool(message)` — returns an `isError` result.
 * - `documented_tool(input)` — a deliberately long description.
 * - `whoami()` — reports whether the request was authenticated.
 *
 * Environment:
 * - `MOCK_MCP_PORT` — listen port (default 3100).
 * - `MOCK_MCP_HOST` — listen host (default 0.0.0.0).
 * - `MOCK_MCP_AUTH` — `none` (default) or `oauth`.
 * - `MOCK_OAUTH_ISSUER` — advertised issuer; must be reachable by the
 *   router (default `http://localhost:<port>`).
 *
 * Every request is logged to stdout, so `docker compose logs
 * mock-mcp-http` (or `mock-mcp-http-oauth`) shows the downstream side of
 * a scenario.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMockMcpServer } from '../mock-mcp-tools.js';
import { createOAuthState, handleOAuthRequest, isAuthorized } from './oauth.js';

/**
 * Parses the listen port from the environment.
 *
 * @returns The port number.
 */
function parsePort(): number {
  const raw = process.env.MOCK_MCP_PORT ?? '3100';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid MOCK_MCP_PORT: ${raw}`);
  }
  return port;
}

const PORT = parsePort();
const HOST = process.env.MOCK_MCP_HOST ?? '0.0.0.0';
const AUTH_MODE = process.env.MOCK_MCP_AUTH === 'oauth';
const ISSUER = process.env.MOCK_OAUTH_ISSUER ?? `http://localhost:${PORT}`;
const OAUTH = createOAuthState(ISSUER);

/**
 * Reads the full request body.
 *
 * @param req - The incoming request.
 * @returns The raw body text.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => resolvePromise(body));
    req.on('error', reject);
  });
}

/**
 * Writes one JSON response.
 *
 * @param res - The server response.
 * @param status - The HTTP status code.
 * @param body - The JSON body.
 * @param headers - Additional response headers.
 */
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Creates the HTTP mock MCP server with the shared tools plus `whoami`.
 *
 * @param authLabel - What `whoami` reports for this request.
 * @returns The MCP server.
 */
function createHttpMockServer(authLabel: string): McpServer {
  const server = createMockMcpServer('qa-mock-http');
  server.registerTool(
    'whoami',
    {
      title: 'Who Am I',
      description: 'Reports whether the request carried a valid bearer token.',
      inputSchema: {},
    },
    async () => {
      return { content: [{ type: 'text' as const, text: authLabel }] };
    },
  );
  return server;
}

/**
 * Describes one JSON-RPC request for the container log.
 *
 * @param parsed - The parsed request body.
 * @returns A short description such as `tools/call add`.
 */
function describeRequest(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null) {
    return 'GET';
  }
  const message = parsed as { method?: string; params?: { name?: string } };
  const name = message.params?.name;
  return `${message.method ?? 'request'}${name === undefined ? '' : ` ${name}`}`;
}

/**
 * Handles one MCP request on `/mcp`.
 *
 * @param req - The incoming request.
 * @param res - The server response.
 * @param body - The raw request body (empty for GET).
 */
async function handleMcp(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
  if (AUTH_MODE && !isAuthorized(OAUTH, req.headers.authorization)) {
    console.log('[mock-mcp-http] rejected unauthenticated MCP request');
    sendJson(
      res,
      401,
      { error: 'invalid_token', error_description: 'bearer token required' },
      {
        'www-authenticate': `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
      },
    );
    return;
  }
  const authLabel = AUTH_MODE ? 'authenticated' : 'anonymous';
  const server = createHttpMockServer(authLabel);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  let parsed: unknown;
  try {
    parsed = body === '' ? undefined : JSON.parse(body);
    await transport.handleRequest(req, res, parsed);
    console.log(`[mock-mcp-http] ${describeRequest(parsed)} (auth=${authLabel})`);
  } catch (err) {
    console.error(`[mock-mcp-http] request failed: ${String(err)}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'internal error' });
    }
  } finally {
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
  }
}

/**
 * Routes one incoming request.
 *
 * @param req - The incoming request.
 * @param res - The server response.
 */
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      auth: AUTH_MODE ? 'oauth' : 'none',
      issuer: ISSUER,
      tools: ['echo', 'add', 'multi_block', 'failing_tool', 'documented_tool', 'whoami'],
    });
    return;
  }
  const body = req.method === 'POST' ? await readBody(req) : '';
  if (AUTH_MODE && (await handleOAuthRequest(req, res, url, body, OAUTH))) {
    return;
  }
  if (url.pathname === '/mcp') {
    await handleMcp(req, res, body);
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

/**
 * Starts the mock HTTP MCP server.
 */
async function main(): Promise<void> {
  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      console.error(`[mock-mcp-http] request failed: ${String(err)}`);
      if (res.headersSent) {
        res.end();
      } else {
        sendJson(res, 500, { error: 'internal error' });
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolvePromise);
  });
  console.log(
    `[mock-mcp-http] listening on http://${HOST}:${PORT} ` +
      `(auth=${AUTH_MODE ? 'oauth' : 'none'}, issuer=${ISSUER})`,
  );
}

main().catch((err: unknown) => {
  console.error(`[mock-mcp-http] fatal error: ${String(err)}`);
  process.exitCode = 1;
});
