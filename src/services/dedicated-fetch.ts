import { Agent, fetch as undiciFetch } from 'undici';
import type { RequestInit as UndiciRequestInit } from 'undici';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * Max concurrent connections per origin for the dedicated agent behind a
 * Streamable HTTP transport. MUST be greater than one: the MCP streamable
 * HTTP spec keeps a long-lived GET SSE stream open while POSTing
 * messages, and a single-connection pool would deadlock — the SSE holds
 * the only socket and every message POST queues behind it forever.
 * Four connections cover the SSE stream plus concurrent message POSTs and
 * the occasional session DELETE without sharing a pool with other
 * servers.
 */
const DEDICATED_FETCH_CONNECTIONS = 4;

/**
 * Idle timeout (ms) for sockets owned by a dedicated agent. Kept short so
 * sockets from a closed transport drain within a second instead of
 * holding the process alive at undici's default 4 s keep-alive.
 */
const DEDICATED_FETCH_KEEP_ALIVE_MS = 1_000;

/**
 * Builds a fetch implementation backed by a dedicated undici `Agent`.
 *
 * Every `StreamableHTTPClientTransport` gets its own agent, so all of a
 * downstream server's traffic — the SSE stream and the message POSTs —
 * runs on connections drawn from a private pool for that transport
 * instead of the shared default fetch pool. This isolates one server's
 * connections from the OAuth metadata probes and from every other
 * server: a probe or another server can never reuse a socket that
 * belongs to this transport (and a connection-sensitive downstream or
 * proxy never sees unrelated requests on the same TCP connection).
 *
 * The agent is intentionally left open-ended: it keeps per-origin
 * keep-alive sockets that drain after {@link DEDICATED_FETCH_KEEP_ALIVE_MS}
 * (the router force-exits on shutdown, so no explicit close is needed).
 *
 * @returns A fetch-compatible function for the caller's transport.
 */
export function createDedicatedFetch(): FetchLike {
  const agent = new Agent({
    connections: DEDICATED_FETCH_CONNECTIONS,
    keepAliveTimeout: DEDICATED_FETCH_KEEP_ALIVE_MS,
  });
  return (url, init) =>
    undiciFetch(url, {
      // undici v8's `RequestInit`/`Response` and the global fetch types come
      // from different type generations (TS 7 ArrayBuffer variance), so the
      // bridge casts below are required; the runtime objects are identical.
      ...(init as unknown as UndiciRequestInit),
      dispatcher: agent,
    }) as unknown as Promise<Response>;
}
