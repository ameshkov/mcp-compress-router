import process from 'node:process';
import type { ServerTimeoutConfig, ServerTimeoutInput } from './types.js';

/**
 * Default startup-phase timeout (ms) for a downstream server: bounds the
 * stdio spawn, the HTTP connect fetch (SSE session GET, OAuth
 * metadata/token handshakes), the `initialize` request, the `tools/list`
 * call, and token refresh — during router startup, self-recovery
 * reconnects, CLI `tools`, and post-`login` discovery. The MCP SDK's own
 * default is 60s; we cap these fast handshake operations sooner so a
 * server that accepts the TCP/TLS connection but never replies (a
 * real-world hang observed on some Streamable HTTP servers behind CDNs)
 * surfaces a clear error instead of blocking the `tools` command or
 * router startup indefinitely.
 *
 * The value matches the ~30 s startup budget most MCP hosts allow:
 * downstream connects run in parallel, so a single timed-out server
 * costs exactly this budget, and the OAuth metadata probes run
 * concurrently with the connects (see `runRouter`). A per-server
 * `timeout.startup` raises or lowers it for one server.
 *
 * @internal Exported for tests only; not part of the public module API.
 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

/**
 * Default tool-execution timeout (ms) passed as the SDK request timeout
 * for `tools/call`, replacing the SDK's 60 s default so a legitimate
 * long-running tool (browser automation, large builds, media processing)
 * is not cut short. It bounds the call only: transport-phase JSON
 * message POSTs stay uncapped.
 *
 * @internal Exported for tests only; not part of the public module API.
 */
export const DEFAULT_EXECUTION_TIMEOUT_MS = 3_600_000;

/**
 * Default timeout (ms) for OAuth metadata discovery probes (RFC 9728 /
 * RFC 8414 well-known endpoint fetches). These are best-effort probes;
 * a server that hangs its well-known endpoint must not stall startup.
 * At startup the probes run concurrently with the downstream connects
 * and the per-server candidates are probed in parallel, so this budget
 * is a per-request cap rather than a serialized startup cost.
 *
 * @internal Exported for tests only; not part of the public module API.
 */
export const DEFAULT_AUTH_DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Reads a positive-integer environment variable, returning `undefined`
 * when unset or invalid (non-integer or non-positive). Invalid values
 * silently fall back to the default rather than aborting startup.
 *
 * Shared by the timeout getters below, which apply the same "positive
 * integer or default" convention.
 *
 * @param name - The environment variable name.
 * @returns The parsed positive integer, or `undefined` when unset/invalid.
 */
function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

/**
 * Resolves the startup-phase timeout in milliseconds. Override with
 * `MCP_COMPRESS_ROUTER_STARTUP_TIMEOUT_MS` (a positive integer); invalid
 * values fall back to {@link DEFAULT_STARTUP_TIMEOUT_MS}.
 *
 * @internal Exported for tests only; not part of the public module API.
 */
export function getStartupTimeoutMs(): number {
  return readPositiveIntEnv('MCP_COMPRESS_ROUTER_STARTUP_TIMEOUT_MS') ?? DEFAULT_STARTUP_TIMEOUT_MS;
}

/**
 * Resolves the tool-execution timeout in milliseconds. Override with
 * `MCP_COMPRESS_ROUTER_EXECUTION_TIMEOUT_MS` (a positive integer);
 * invalid values fall back to {@link DEFAULT_EXECUTION_TIMEOUT_MS}.
 *
 * @internal Exported for tests only; not part of the public module API.
 */
export function getExecutionTimeoutMs(): number {
  return (
    readPositiveIntEnv('MCP_COMPRESS_ROUTER_EXECUTION_TIMEOUT_MS') ?? DEFAULT_EXECUTION_TIMEOUT_MS
  );
}

/**
 * Resolves a server's effective timeouts with precedence per-server
 * value > environment variable > built-in default.
 *
 * @param input - Optional per-server timeout overrides from config.
 * @returns The resolved startup/execution pair, both always present.
 */
export function resolveServerTimeouts(input?: ServerTimeoutInput): ServerTimeoutConfig {
  return {
    startup: input?.startup ?? getStartupTimeoutMs(),
    execution: input?.execution ?? getExecutionTimeoutMs(),
  };
}

/**
 * Resolves the OAuth discovery probe timeout in milliseconds. Override
 * with `MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS` (a positive
 * integer); invalid values fall back to
 * {@link DEFAULT_AUTH_DISCOVERY_TIMEOUT_MS}.
 */
export function getAuthDiscoveryTimeoutMs(): number {
  return (
    readPositiveIntEnv('MCP_COMPRESS_ROUTER_AUTH_DISCOVERY_TIMEOUT_MS') ??
    DEFAULT_AUTH_DISCOVERY_TIMEOUT_MS
  );
}

/**
 * Wraps the global `fetch` so each request aborts after `timeoutMs`.
 * The caller's own `init.signal` (if any) is honored alongside the
 * timeout signal via `AbortSignal.any`.
 *
 * Used to add a request-level timeout to SDK helpers (OAuth metadata
 * discovery) that accept a custom `fetchFn` but expose no timeout option
 * of their own — without it, a server that hangs the well-known endpoint
 * traps discovery forever.
 *
 * @param timeoutMs - Per-request timeout in milliseconds.
 * @returns A fetch-compatible function that aborts on timeout.
 */
export function createTimeoutFetch(timeoutMs: number): typeof fetch {
  return (input, init) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    return fetch(input, { ...init, signal });
  };
}
