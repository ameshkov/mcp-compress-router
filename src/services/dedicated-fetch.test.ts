import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDedicatedFetch } from './dedicated-fetch.js';

/**
 * Live HTTP server that mimics the shape of an MCP streamable HTTP
 * endpoint: a long-lived `/sse` stream (never ends until aborted) plus
 * normal message endpoints alongside it.
 */
describe('createDedicatedFetch', () => {
  let server: http.Server;
  let origin: string;
  let seen: http.IncomingHttpHeaders = {};

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        server = http.createServer((req, res) => {
          if (req.url === '/sse') {
            // Never completes — simulates the SSE message stream.
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: ready\n\n');
            return;
          }
          seen = req.headers;
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
        });
        server.listen(0, () => {
          const addr = server.address() as AddressInfo;
          origin = `http://localhost:${addr.port}`;
          resolve();
        });
      }),
  );

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  it('performs a fetch against a downstream server', async () => {
    const fetchFn = createDedicatedFetch();
    const res = await fetchFn(`${origin}/message`);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('ok');
  });

  it('forwards the request init (e.g. headers) to the server', async () => {
    const fetchFn = createDedicatedFetch();
    const res = await fetchFn(`${origin}/message`, {
      method: 'POST',
      headers: { 'x-test': 'abc' },
    });
    expect(res.ok).toBe(true);
    expect(seen['x-test']).toBe('abc');
  });

  it('does not deadlock when an SSE stream and a message POST run concurrently', async () => {
    // Regression guard: a single-connection pool would keep every POST
    // queued behind the never-ending SSE stream. The dedicated agent must
    // serve the POST from a second connection.
    const fetchFn = createDedicatedFetch();
    const sseRes = await fetchFn(`${origin}/sse`); // headers arrive, body streams
    expect(sseRes.ok).toBe(true);

    const postResult = await Promise.race([
      fetchFn(`${origin}/message`, { method: 'POST' }).then((res) => ({
        ok: res.ok,
        timedOut: false,
      })),
      new Promise<{ ok: boolean; timedOut: boolean }>((resolve) =>
        setTimeout(() => resolve({ ok: false, timedOut: true }), 1500),
      ),
    ]);

    expect(postResult.timedOut).toBe(false);
    expect(postResult.ok).toBe(true);

    await sseRes.body?.cancel();
  });
});
