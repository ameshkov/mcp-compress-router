import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_DOWNSTREAM_TIMEOUT_MS,
  DEFAULT_AUTH_DISCOVERY_TIMEOUT_MS,
  getDownstreamTimeoutMs,
  getAuthDiscoveryTimeoutMs,
  createTimeoutFetch,
} from './timeout.js';

describe('timeout — env defaults', () => {
  const prevDown = process.env.MCP_COMPRESS_ROUTER_DOWNSTREAM_TIMEOUT_MS;
  const prevAuth = process.env.MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS;

  afterEach(() => {
    if (prevDown === undefined) delete process.env.MCP_COMPRESS_ROUTER_DOWNSTREAM_TIMEOUT_MS;
    else process.env.MCP_COMPRESS_ROUTER_DOWNSTREAM_TIMEOUT_MS = prevDown;
    if (prevAuth === undefined) delete process.env.MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS;
    else process.env.MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS = prevAuth;
  });

  it('returns the documented defaults when the env vars are unset', () => {
    delete process.env.MCP_COMPRESS_ROUTER_DOWNSTREAM_TIMEOUT_MS;
    delete process.env.MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS;
    expect(getDownstreamTimeoutMs()).toBe(DEFAULT_DOWNSTREAM_TIMEOUT_MS);
    expect(getAuthDiscoveryTimeoutMs()).toBe(DEFAULT_AUTH_DISCOVERY_TIMEOUT_MS);
  });

  it('honors a positive-integer override', () => {
    process.env.MCP_COMPRESS_ROUTER_DOWNSTREAM_TIMEOUT_MS = '7000';
    process.env.MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS = '2500';
    expect(getDownstreamTimeoutMs()).toBe(7000);
    expect(getAuthDiscoveryTimeoutMs()).toBe(2500);
  });

  it('falls back to the default for invalid values', () => {
    for (const bad of ['not-a-number', '0', '-5', '3.5', '']) {
      process.env.MCP_COMPRESS_ROUTER_DOWNSTREAM_TIMEOUT_MS = bad;
      process.env.MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS = bad;
      expect(getDownstreamTimeoutMs()).toBe(DEFAULT_DOWNSTREAM_TIMEOUT_MS);
      expect(getAuthDiscoveryTimeoutMs()).toBe(DEFAULT_AUTH_DISCOVERY_TIMEOUT_MS);
    }
  });
});

describe('createTimeoutFetch', () => {
  let server: http.Server;
  let url: string;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        server = http.createServer((_req, res) => {
          // Never respond — simulates a hung endpoint.
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          // Intentionally leave the response open.
        });
        server.listen(0, () => {
          const addr = server.address() as AddressInfo;
          url = `http://localhost:${addr.port}/`;
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

  it('aborts a hung response after the timeout', async () => {
    const fetchFn = createTimeoutFetch(150);
    const start = Date.now();
    await expect(fetchFn(url)).rejects.toThrow();
    const elapsed = Date.now() - start;
    // Aborts promptly around the 150ms budget (allow scheduling slack).
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(2000);
  });

  it('returns the response when the server replies before the timeout', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address() as AddressInfo;
        url = `http://localhost:${addr.port}/`;
        resolve();
      });
    });

    const fetchFn = createTimeoutFetch(5000);
    const res = await fetchFn(url);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('ok');
  });
});
