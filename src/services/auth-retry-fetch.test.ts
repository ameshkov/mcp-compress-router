import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createAuthRetryFetch } from './auth-retry-fetch.js';
import { OAuthCredentialManager } from './oauth.js';
import { writeCredentials } from '../cli/config-io.js';
import { Logger } from '../utils/index.js';
import type { DownstreamServerConfig } from '../utils/index.js';

// Hoisted mocks for the OAuth discovery and SDK refresh functions, so
// the retry wrapper can be exercised with a real OAuthCredentialManager
// without real network I/O. `refreshAuthorization` is imported as a
// top-level static value in oauth-token-refresh.ts; vitest's hoisted
// mock intercepts it at the module registry level before any static
// import is evaluated. The rest of the SDK auth module stays real.
const { discoverAuthMock, refreshAuthorizationMock } = vi.hoisted(() => ({
  discoverAuthMock: vi.fn(),
  refreshAuthorizationMock: vi.fn(),
}));

vi.mock('./oauth-discovery.js', () => ({
  discoverAuth: discoverAuthMock,
}));

vi.mock('@modelcontextprotocol/sdk/client/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/client/auth.js')>();
  return {
    ...actual,
    refreshAuthorization: refreshAuthorizationMock,
  };
});

const AS_URL = new URL('https://as.example.com/');

const SERVER_METADATA = {
  issuer: 'https://as.example.com/',
  token_endpoint: 'https://as.example.com/token',
  authorization_endpoint: 'https://as.example.com/authorize',
};

const server: DownstreamServerConfig = {
  name: 'test-server',
  description: 'Test OAuth server',
  type: 'http',
  url: 'https://example.com/mcp',
};

const MCP_URL = 'https://example.com/mcp';

/** Absolute expiry of the seeded stale access token (in the past). */
const STALE_EXPIRES_AT = '2026-06-22T11:00:00Z';

/** Fresh token response the mocked token request resolves with. */
const FRESH_TOKENS = {
  access_token: 'fresh-at',
  refresh_token: 'fresh-rt',
  expires_in: 3600,
  token_type: 'Bearer',
} as const;

/** One recorded base-fetch invocation. */
interface RecordedCall {
  url: string | URL;
  init: RequestInit | undefined;
}

/**
 * A fake FetchLike that returns the queued responses in call order and
 * records every invocation, so tests can assert what each retry carried.
 */
function queueFetch(responses: Response[]): {
  fetchFn: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const response = responses[calls.length - 1];
    if (response === undefined) {
      throw new Error('Unexpected extra fetch call');
    }
    return response;
  };
  return { fetchFn, calls };
}

/**
 * A response body stream that records each `cancel()` call into a shared
 * event log, so tests can assert that a rejected response body was
 * cancelled — and in which order relative to the retried fetch.
 */
class TrackingStream extends ReadableStream<Uint8Array> {
  private readonly events: string[];
  private readonly label: string;

  constructor(events: string[], label: string) {
    super();
    this.events = events;
    this.label = label;
  }

  override async cancel(): Promise<void> {
    this.events.push(this.label);
  }
}

/** Builds a response whose body records cancellation under `label`. */
function trackedResponse(status: number, events: string[], label: string): Response {
  return new Response(new TrackingStream(events, label), { status });
}

describe('createAuthRetryFetch', () => {
  let tmpDir: string;
  let configPath: string;
  let logger: Logger;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-auth-retry-'));
    configPath = path.join(tmpDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }));

    logger = new Logger('debug');
    warnSpy = vi.spyOn(logger, 'warn');
    debugSpy = vi.spyOn(logger, 'debug');

    discoverAuthMock.mockReset();
    refreshAuthorizationMock.mockReset();
    // Sensible defaults so individual tests only override what they
    // assert against.
    discoverAuthMock.mockResolvedValue({
      serverMetadata: SERVER_METADATA,
      authorizationServerUrl: AS_URL,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true });
  });

  /**
   * Seeds a stored credential entry for the test server with a client
   * registration so the coordinated refresh path can issue a token
   * request when it needs to.
   */
  async function seedStoredTokens(accessToken: string, refreshToken?: string): Promise<void> {
    await writeCredentials(configPath, server.name, {
      clientRegistration: { client_id: 'reg-id' },
      tokens: {
        access_token: accessToken,
        token_type: 'Bearer',
        ...(refreshToken !== undefined ? { refresh_token: refreshToken } : {}),
        expires_in: 3600,
        scope: 'read',
        expires_at: STALE_EXPIRES_AT,
      },
      authRequirement: 'oauth',
      checkedAt: '2026-06-22T12:00:00Z',
    });
  }

  it('returns the base fetch unchanged when no manager is configured', () => {
    const baseFetch: FetchLike = vi.fn(async () => new Response(null, { status: 200 }));

    expect(createAuthRetryFetch(baseFetch, undefined)).toBe(baseFetch);
  });

  it('passes non-401 responses through untouched', async () => {
    const response = new Response(null, { status: 200 });
    const { fetchFn } = queueFetch([response]);
    const mgr = new OAuthCredentialManager(configPath, server);
    const refreshSpy = vi.spyOn(mgr, 'refreshAfterUnauthorized');
    const wrapped = createAuthRetryFetch(fetchFn, mgr, logger);

    const result = await wrapped(MCP_URL, {
      headers: { authorization: 'Bearer stale-at' },
    });

    expect(result).toBe(response);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('passes through requests that carry no bearer token', async () => {
    const missing = new Response(null, { status: 401 });
    const malformed = new Response(null, { status: 401 });
    const { fetchFn, calls } = queueFetch([missing, malformed]);
    const mgr = new OAuthCredentialManager(configPath, server);
    const refreshSpy = vi.spyOn(mgr, 'refreshAfterUnauthorized');
    const wrapped = createAuthRetryFetch(fetchFn, mgr, logger);

    const noHeader = await wrapped(MCP_URL, { method: 'POST', body: '{}' });
    const basic = await wrapped(MCP_URL, { headers: { authorization: 'Basic dXNlcg==' } });

    expect(noHeader).toBe(missing);
    expect(basic).toBe(malformed);
    expect(calls).toHaveLength(2);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('retries once with an adopted token without a refresh', async () => {
    await seedStoredTokens('adopted-at', 'stored-rt');
    const mgr = new OAuthCredentialManager(configPath, server);
    // A recent 401 left the backoff active; adopting another process's
    // token must still work and the successful retry must clear it.
    mgr.noteAuthFailure();

    const events: string[] = [];
    const first = trackedResponse(401, events, 'cancel-401');
    const retried = trackedResponse(200, events, 'cancel-retry');
    const { fetchFn, calls } = queueFetch([first, retried]);
    const wrapped = createAuthRetryFetch(fetchFn, mgr, logger);

    const result = await wrapped(MCP_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer used-at' },
      body: '{"jsonrpc":"2.0"}',
    });

    expect(result).toBe(retried);
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[1].init?.headers).get('authorization')).toBe('Bearer adopted-at');
    expect(calls[1].init?.body).toBe('{"jsonrpc":"2.0"}');
    // Adoption means no token request and no discovery.
    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
    expect(discoverAuthMock).not.toHaveBeenCalled();
    // The successful retry cleared the previously recorded backoff.
    expect((await mgr.tokens())?.refresh_token).toBe('stored-rt');
  });

  it('retries once with a refreshed token after a coordinated refresh', async () => {
    await seedStoredTokens('used-at', 'stored-rt');
    refreshAuthorizationMock.mockResolvedValue(FRESH_TOKENS);

    const mgr = new OAuthCredentialManager(configPath, server);
    const events: string[] = [];
    const first = trackedResponse(401, events, 'cancel-401');
    const retried = trackedResponse(200, events, 'cancel-retry');
    const { fetchFn, calls } = queueFetch([first, retried]);
    const wrapped = createAuthRetryFetch(fetchFn, mgr, logger);

    const result = await wrapped(MCP_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer used-at' },
      body: '{"jsonrpc":"2.0"}',
    });

    expect(result).toBe(retried);
    expect(refreshAuthorizationMock).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[1].init?.headers).get('authorization')).toBe('Bearer fresh-at');
    // The rejected body was cancelled before the retry; the successful
    // retry body was not.
    expect(events).toEqual(['cancel-401']);
    expect(debugSpy).toHaveBeenCalledWith(
      'Adopted or refreshed OAuth token; retrying request',
      expect.objectContaining({ server: 'test-server' }),
    );
  });

  it('cancels the rejected response body before retrying', async () => {
    await seedStoredTokens('adopted-at', 'stored-rt');

    const mgr = new OAuthCredentialManager(configPath, server);
    const events: string[] = [];
    const first = trackedResponse(401, events, 'cancel-401');
    const retried = trackedResponse(200, events, 'cancel-retry');
    const { fetchFn } = queueFetch([first, retried]);
    // Record fetch order around the base fetch so cancellation is proven
    // to happen before the retry goes out.
    const wrapped = createAuthRetryFetch(
      async (url, init) => {
        events.push(`fetch:${url.toString()}`);
        return fetchFn(url, init);
      },
      mgr,
      logger,
    );

    await wrapped(MCP_URL, { headers: { authorization: 'Bearer used-at' } });

    expect(events).toEqual([`fetch:${MCP_URL}`, 'cancel-401', `fetch:${MCP_URL}`]);
  });

  it('records the auth failure and returns the terminal 401 when the updated token is rejected', async () => {
    await seedStoredTokens('used-at', 'stored-rt');
    refreshAuthorizationMock.mockResolvedValue(FRESH_TOKENS);

    const mgr = new OAuthCredentialManager(configPath, server);
    const events: string[] = [];
    const first = trackedResponse(401, events, 'cancel-first');
    const retried = trackedResponse(401, events, 'cancel-retried');
    const { fetchFn, calls } = queueFetch([first, retried]);
    const wrapped = createAuthRetryFetch(fetchFn, mgr, logger);

    const result = await wrapped(MCP_URL, { headers: { authorization: 'Bearer used-at' } });

    // The terminal response is the retried 401, with its body cancelled.
    expect(result).toBe(retried);
    expect(calls).toHaveLength(2);
    expect(events).toEqual(['cancel-first', 'cancel-retried']);
    expect(warnSpy).toHaveBeenCalledWith(
      'OAuth token still rejected; entering auth-failure backoff',
      expect.objectContaining({ server: 'test-server' }),
    );
    // The backoff hides the refresh token from the SDK's auth() flow.
    expect((await mgr.tokens())?.refresh_token).toBeUndefined();
  });

  it('retries once when the refresh returns the same access token value', async () => {
    await seedStoredTokens('same-at', 'stored-rt');
    refreshAuthorizationMock.mockResolvedValue({ ...FRESH_TOKENS, access_token: 'same-at' });

    const mgr = new OAuthCredentialManager(configPath, server);
    const events: string[] = [];
    const first = trackedResponse(401, events, 'cancel-401');
    const retried = trackedResponse(200, events, 'cancel-retry');
    const { fetchFn, calls } = queueFetch([first, retried]);
    const wrapped = createAuthRetryFetch(fetchFn, mgr, logger);

    const result = await wrapped(MCP_URL, { headers: { authorization: 'Bearer same-at' } });

    // The coordinated refresh ran and returned a token, so the wrapper
    // retries even though the access token value is unchanged.
    expect(refreshAuthorizationMock).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(result).toBe(retried);
    expect(new Headers(calls[1].init?.headers).get('authorization')).toBe('Bearer same-at');
  });

  it('returns the 401 untouched when no adoption or refresh could be attempted', async () => {
    // The stored token equals the rejected one and no refresh token
    // exists, so the manager yields no replacement.
    await seedStoredTokens('used-at');

    const mgr = new OAuthCredentialManager(configPath, server);
    const events: string[] = [];
    const first = trackedResponse(401, events, 'cancel-401');
    const { fetchFn, calls } = queueFetch([first]);
    const wrapped = createAuthRetryFetch(fetchFn, mgr, logger);

    const result = await wrapped(MCP_URL, { headers: { authorization: 'Bearer used-at' } });

    expect(result).toBe(first);
    expect(calls).toHaveLength(1);
    // The body is left intact for the SDK's auth() flow to read.
    expect(events).toEqual([]);
    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
    // The manager had nothing to adopt or refresh, so the SDK receives
    // no refresh token and terminates through its auth() flow.
    expect((await mgr.tokens())?.refresh_token).toBeUndefined();
  });

  it('records the auth failure and returns the original 401 when the coordinated refresh throws', async () => {
    await seedStoredTokens('used-at', 'stored-rt');
    refreshAuthorizationMock.mockRejectedValue(new Error('network down'));

    const mgr = new OAuthCredentialManager(configPath, server);
    const events: string[] = [];
    const first = trackedResponse(401, events, 'cancel-401');
    const { fetchFn, calls } = queueFetch([first]);
    const wrapped = createAuthRetryFetch(fetchFn, mgr, logger);

    const result = await wrapped(MCP_URL, { headers: { authorization: 'Bearer used-at' } });

    expect(result).toBe(first);
    expect(calls).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'Coordinated OAuth token refresh failed',
      expect.objectContaining({ server: 'test-server', error: 'network down' }),
    );
    // The original 401 body is left intact for the SDK's auth() flow.
    expect(events).toEqual([]);
    // The breaker is engaged: tokens() omits refresh_token, so the
    // SDK's auth() terminates instead of refreshing uncoordinated.
    expect((await mgr.tokens())?.refresh_token).toBeUndefined();
  });

  it('reuses the request body and updates only the authorization header on retry', async () => {
    await seedStoredTokens('adopted-at', 'stored-rt');

    const mgr = new OAuthCredentialManager(configPath, server);
    const events: string[] = [];
    const first = trackedResponse(401, events, 'cancel-401');
    const retried = trackedResponse(200, events, 'cancel-retry');
    const { fetchFn, calls } = queueFetch([first, retried]);
    const wrapped = createAuthRetryFetch(fetchFn, mgr, logger);

    const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: {} });
    await wrapped(MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-trace': 'keep-me',
        authorization: 'Bearer used-at',
      },
      body,
    });

    // JSON-RPC bodies are strings, so the same body is replayed verbatim.
    expect(calls[1].init?.body).toBe(body);
    const retryHeaders = new Headers(calls[1].init?.headers);
    expect(retryHeaders.get('authorization')).toBe('Bearer adopted-at');
    expect(retryHeaders.get('content-type')).toBe('application/json');
    expect(retryHeaders.get('x-trace')).toBe('keep-me');
  });

  it('shares one refresh attempt across concurrent 401s', async () => {
    await seedStoredTokens('used-at', 'stored-rt');
    // Slow the token request so the two wrapper calls overlap.
    refreshAuthorizationMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(FRESH_TOKENS), 50)),
    );

    const mgr = new OAuthCredentialManager(configPath, server);
    const events: string[] = [];
    const first = trackedResponse(401, events, 'cancel-first');
    const second = trackedResponse(401, events, 'cancel-second');
    const retriedFirst = trackedResponse(200, events, 'cancel-retried-first');
    const retriedSecond = trackedResponse(200, events, 'cancel-retried-second');
    const { fetchFn, calls } = queueFetch([first, second, retriedFirst, retriedSecond]);
    const wrapped = createAuthRetryFetch(fetchFn, mgr, logger);

    const [a, b] = await Promise.all([
      wrapped(MCP_URL, { headers: { authorization: 'Bearer used-at' } }),
      wrapped(MCP_URL, { headers: { authorization: 'Bearer used-at' } }),
    ]);

    expect(refreshAuthorizationMock).toHaveBeenCalledTimes(1);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(calls).toHaveLength(4);
    // Both retried requests carried the one freshly refreshed token.
    const retryTokens = calls
      .slice(2)
      .map((call) => new Headers(call.init?.headers).get('authorization'));
    expect(retryTokens).toEqual(['Bearer fresh-at', 'Bearer fresh-at']);
  });
});
