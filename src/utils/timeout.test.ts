import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  DEFAULT_AUTH_DISCOVERY_TIMEOUT_MS,
  getStartupTimeoutMs,
  getExecutionTimeoutMs,
  getAuthDiscoveryTimeoutMs,
  resolveServerTimeouts,
  createTimeoutFetch,
} from './timeout.js';

const ENV_STARTUP = 'MCP_COMPRESS_ROUTER_STARTUP_TIMEOUT_MS';
const ENV_EXECUTION = 'MCP_COMPRESS_ROUTER_EXECUTION_TIMEOUT_MS';
const ENV_AUTH = 'MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS';

describe('timeout — env defaults', () => {
  const prevStartup = process.env[ENV_STARTUP];
  const prevExecution = process.env[ENV_EXECUTION];
  const prevAuth = process.env[ENV_AUTH];

  afterEach(() => {
    if (prevStartup === undefined) delete process.env[ENV_STARTUP];
    else process.env[ENV_STARTUP] = prevStartup;
    if (prevExecution === undefined) delete process.env[ENV_EXECUTION];
    else process.env[ENV_EXECUTION] = prevExecution;
    if (prevAuth === undefined) delete process.env[ENV_AUTH];
    else process.env[ENV_AUTH] = prevAuth;
  });

  it('returns the documented defaults when the env vars are unset', () => {
    delete process.env[ENV_STARTUP];
    delete process.env[ENV_EXECUTION];
    delete process.env[ENV_AUTH];
    expect(getStartupTimeoutMs()).toBe(30_000);
    expect(getExecutionTimeoutMs()).toBe(3_600_000);
    expect(getAuthDiscoveryTimeoutMs()).toBe(DEFAULT_AUTH_DISCOVERY_TIMEOUT_MS);
    // The auth discovery budget stays well under the startup default.
    expect(DEFAULT_AUTH_DISCOVERY_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it('honors a positive-integer override and falls back to the default for invalid values', () => {
    process.env[ENV_STARTUP] = '7000';
    process.env[ENV_EXECUTION] = '120000';
    expect(getStartupTimeoutMs()).toBe(7000);
    expect(getExecutionTimeoutMs()).toBe(120000);

    for (const bad of ['not-a-number', '0', '-5', '3.5', '']) {
      process.env[ENV_STARTUP] = bad;
      process.env[ENV_EXECUTION] = bad;
      expect(getStartupTimeoutMs()).toBe(DEFAULT_STARTUP_TIMEOUT_MS);
      expect(getExecutionTimeoutMs()).toBe(DEFAULT_EXECUTION_TIMEOUT_MS);
    }
  });

  it('resolves per-server values over the environment over the defaults', () => {
    delete process.env[ENV_STARTUP];
    delete process.env[ENV_EXECUTION];
    expect(resolveServerTimeouts()).toEqual({
      startup: DEFAULT_STARTUP_TIMEOUT_MS,
      execution: DEFAULT_EXECUTION_TIMEOUT_MS,
    });
    expect(resolveServerTimeouts({})).toEqual({
      startup: DEFAULT_STARTUP_TIMEOUT_MS,
      execution: DEFAULT_EXECUTION_TIMEOUT_MS,
    });

    process.env[ENV_STARTUP] = '9000';
    process.env[ENV_EXECUTION] = '900000';
    expect(resolveServerTimeouts()).toEqual({ startup: 9000, execution: 900000 });

    expect(resolveServerTimeouts({ startup: 1000 })).toEqual({
      startup: 1000,
      execution: 900000,
    });
    expect(resolveServerTimeouts({ startup: 1000, execution: 2000 })).toEqual({
      startup: 1000,
      execution: 2000,
    });
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
