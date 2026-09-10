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

/**
 * How far the connect timeout governs a request: `'headers'` stops once
 * response headers arrive (the SSE session GET streams forever), while
 * `'body'` stays armed until the response body is consumed (metadata
 * discovery and the OAuth token exchange read a finite body and must not
 * stall on a server that sends headers and then goes silent).
 */
type ConnectBound = 'headers' | 'body';

/**
 * Wraps a {@link FetchLike} so the awaits in the HTTP transport connect
 * path are bounded: the SSE session GET, the OAuth metadata discovery
 * GETs, and the OAuth token exchange POST (a TCP-accepting-but-silent
 * server, or a hung token endpoint, would otherwise stall
 * `client.connect()` forever).
 *
 * The timeout covers the response-header phase for every bounded request
 * and additionally the response-body read for requests whose body is
 * consumed during connect (metadata + token exchange). The long-lived SSE
 * response body is deliberately exempt: its `Accept: text/event-stream`
 * header marks it, so it streams for its natural duration. An abort
 * raises a descriptive timeout error instead of undici's bare
 * `AbortError`.
 *
 * Requests that can legitimately run long are NOT bounded:
 * - JSON message POSTs (`tools/call` and friends) — the response headers
 *   only arrive once the downstream finishes processing the request.
 * - Any other method (e.g. the session DELETE on close).
 *
 * @param baseFetch - The underlying fetch (e.g. a dedicated undici fetch).
 * @param timeoutMs - Connect timeout in milliseconds.
 * @returns A fetch-compatible function with the connect timeout applied.
 */
export function createConnectTimeoutFetch(baseFetch: FetchLike, timeoutMs: number): FetchLike {
  return (url, init) => {
    const bound = classifyConnectBound(init);
    if (bound === undefined) {
      return baseFetch(url, init);
    }
    const controller = new AbortController();
    const timedOut = { current: false };
    const timer = setTimeout(() => {
      timedOut.current = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    const signal =
      init !== undefined && init.signal
        ? AbortSignal.any([init.signal, controller.signal])
        : controller.signal;
    return baseFetch(url, { ...init, signal })
      .then((response) => {
        if (bound === 'headers') {
          clearTimeout(timer);
          return response;
        }
        return boundResponseBody(response, timer, timedOut, timeoutMs);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        if (timedOut.current) {
          throw timeoutError('response headers', timeoutMs);
        }
        throw err;
      });
  };
}

/**
 * Decides whether a request is part of the connect/auth handshake that
 * must be bounded, and how far the timeout reaches. GETs bound their body
 * too (metadata discovery) unless they request an SSE stream — the SSE
 * session GET streams forever and must only be bounded at the header
 * phase. Form-encoded POSTs bound their body (OAuth token exchange).
 * JSON message POSTs are deliberately excluded — their headers arrive
 * only when the downstream finishes the request, which may take minutes
 * for a long tool call.
 *
 * @param init - Request init, if any.
 * @returns The bound scope, or undefined when the request is unbounded.
 */
function classifyConnectBound(init?: RequestInit): ConnectBound | undefined {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'GET') {
    return acceptsEventStream(init) ? 'headers' : 'body';
  }
  if (method === 'POST') {
    const contentType = new Headers(init?.headers).get('content-type') ?? '';
    return contentType.includes('application/x-www-form-urlencoded') ? 'body' : undefined;
  }
  return undefined;
}

/**
 * Whether the request asks for an SSE stream (`Accept: text/event-stream`),
 * which is exempt from the body-phase timeout.
 */
function acceptsEventStream(init?: RequestInit): boolean {
  const accept = new Headers(init?.headers).get('accept') ?? '';
  return accept.includes('text/event-stream');
}

/**
 * Keeps the connect timer armed after headers arrive and wraps the
 * response body readers so a timeout mid-read surfaces as a descriptive
 * error (and the timer is cleared once a read settles).
 */
function boundResponseBody(
  response: Response,
  timer: NodeJS.Timeout,
  timedOut: { current: boolean },
  timeoutMs: number,
): Response {
  response.json = withBodyTimeout(response.json.bind(response), timer, timedOut, timeoutMs);
  response.text = withBodyTimeout(response.text.bind(response), timer, timedOut, timeoutMs);
  response.arrayBuffer = withBodyTimeout(
    response.arrayBuffer.bind(response),
    timer,
    timedOut,
    timeoutMs,
  );
  response.blob = withBodyTimeout(response.blob.bind(response), timer, timedOut, timeoutMs);
  return response;
}

/**
 * Wraps a body reader so it clears the connect timer when it settles and
 * converts an abort caused by that timer into a descriptive error.
 */
function withBodyTimeout<T>(
  read: () => Promise<T>,
  timer: NodeJS.Timeout,
  timedOut: { current: boolean },
  timeoutMs: number,
): () => Promise<T> {
  return async () => {
    try {
      return await read();
    } catch (err) {
      if (timedOut.current) {
        throw timeoutError('the response body', timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Builds the error raised when the connect timeout fires while waiting for
 * the given handshake phase.
 */
function timeoutError(phase: string, timeoutMs: number): Error {
  return new Error(
    `Timed out after ${timeoutMs}ms waiting for ${phase} from the downstream server.`,
  );
}
