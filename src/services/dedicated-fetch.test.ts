import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDedicatedFetch, createConnectTimeoutFetch } from './dedicated-fetch.js';

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

describe('createConnectTimeoutFetch', () => {
  let server: http.Server;
  let origin: string;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        server = http.createServer((req, res) => {
          if (req.url === '/hang') {
            // Accept the connection but never send response headers.
            return;
          }
          if (req.url === '/slow') {
            // Headers arrive well after the request started.
            setTimeout(() => {
              res.writeHead(200, { 'Content-Type': 'text/plain' });
              res.end('slow-ok');
            }, 300);
            return;
          }
          if (req.url === '/stall-body') {
            // Headers arrive immediately, then the body never completes.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write('{"partial":');
            return;
          }
          if (req.url === '/stream') {
            // Long-lived SSE stream: headers + one event, never ends.
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: ready\n\n');
            return;
          }
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
        server.closeAllConnections();
      }),
  );

  it('aborts a GET that never sends response headers after the timeout', async () => {
    const fetchFn = createConnectTimeoutFetch(createDedicatedFetch(), 200);
    await expect(fetchFn(`${origin}/hang`, { method: 'GET' })).rejects.toThrow(
      /Timed out after 200ms waiting for response headers/,
    );
  });

  it('bounds the OAuth token POST (form-encoded) with the same timeout', async () => {
    const fetchFn = createConnectTimeoutFetch(createDedicatedFetch(), 200);
    await expect(
      fetchFn(`${origin}/hang`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code' }),
      }),
    ).rejects.toThrow(/Timed out after 200ms waiting for response headers/);
  });

  it('bounds the OAuth token response body once headers arrive', async () => {
    const fetchFn = createConnectTimeoutFetch(createDedicatedFetch(), 100);
    const res = await fetchFn(`${origin}/stall-body`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code' }),
    });
    expect(res.ok).toBe(true);
    await expect(res.text()).rejects.toThrow(/Timed out after 100ms waiting for the response body/);
  });

  it('bounds the metadata discovery GET response body once headers arrive', async () => {
    const fetchFn = createConnectTimeoutFetch(createDedicatedFetch(), 100);
    const res = await fetchFn(`${origin}/stall-body`, {
      headers: { accept: 'application/json' },
    });
    expect(res.ok).toBe(true);
    await expect(res.json()).rejects.toThrow(/Timed out after 100ms waiting for the response body/);
  });

  it('does NOT bound JSON message POSTs (long-running tool calls)', async () => {
    const fetchFn = createConnectTimeoutFetch(createDedicatedFetch(), 100);
    const res = await fetchFn(`${origin}/slow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"id":1}',
    });
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('slow-ok');
  });

  it('does not bound the long-lived SSE session GET body', async () => {
    const fetchFn = createConnectTimeoutFetch(createDedicatedFetch(), 100);
    const res = await fetchFn(`${origin}/stream`, {
      headers: { accept: 'text/event-stream' },
    });
    expect(res.ok).toBe(true);

    // Wait past the timeout; an aborted stream would make the read reject.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const reader = res.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain('data: ready');
    await reader?.cancel();
  });

  it('clears the timeout once a bounded body is fully read', async () => {
    const fetchFn = createConnectTimeoutFetch(createDedicatedFetch(), 200);
    const res = await fetchFn(`${origin}/ok`, { headers: { accept: 'application/json' } });
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('ok');
  });
});
