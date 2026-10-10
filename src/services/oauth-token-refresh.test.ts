import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { requestTokenRefresh } from './oauth-token-refresh.js';

// Hoisted mocks for the OAuth discovery and SDK refresh functions.
// `discoverAuth` and `refreshAuthorization` are replaced so the refresh
// request can be exercised without real network I/O. The rest of the SDK
// auth module stays real, including `selectResourceURL` (which
// oauth-token-refresh.ts also imports), so the resource indicator the
// refresh carries is derived by the same code the SDK's auth() flow
// uses. `createTimeoutFetch` is mocked so the test can pin that the
// refresh installs the bounded fetch (and the timeout it was built
// with) instead of the bare global fetch.
const { createTimeoutFetchMock, discoverAuthMock, refreshAuthorizationMock } = vi.hoisted(() => ({
  createTimeoutFetchMock: vi.fn(),
  discoverAuthMock: vi.fn(),
  refreshAuthorizationMock: vi.fn(),
}));

vi.mock('./oauth-discovery.js', () => ({
  discoverAuth: discoverAuthMock,
}));

vi.mock('../utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/index.js')>();
  return {
    ...actual,
    createTimeoutFetch: createTimeoutFetchMock,
  };
});

vi.mock('@modelcontextprotocol/sdk/client/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/client/auth.js')>();
  return {
    ...actual,
    refreshAuthorization: refreshAuthorizationMock,
  };
});

/** Fresh mock token response returned by `refreshAuthorization`. */
const FRESH_TOKENS: OAuthTokens = {
  access_token: 'fresh-at',
  refresh_token: 'fresh-rt',
  expires_in: 3600,
  token_type: 'Bearer',
};

const AS_URL = new URL('https://as.example.com/');

const SERVER_METADATA = {
  issuer: 'https://as.example.com/',
  token_endpoint: 'https://as.example.com/token',
  authorization_endpoint: 'https://as.example.com/authorize',
};

const SERVER_URL = 'https://example.com/mcp';

const RESOURCE_METADATA = {
  resource: SERVER_URL,
  authorization_servers: ['https://as.example.com/'],
};

/** Sentinel fetch the mocked `createTimeoutFetch` returns. */
const BOUNDED_FETCH = vi.fn() as unknown as typeof fetch;

/**
 * Builds the structural refresh context and its spies. The context type
 * is module-private, so callers construct it structurally — exactly as
 * the manager does.
 *
 * @param serverUrl - The downstream server URL, or undefined when the
 *   server has none.
 * @param clientInformation - The client registration the provider
 *   returns, or undefined when none is registered.
 * @returns The context plus the `setIssuer` and `saveTokens` spies.
 */
function createContext(
  serverUrl: string | undefined,
  clientInformation?: OAuthClientInformationMixed,
) {
  const setIssuer = vi.fn();
  const saveTokens = vi.fn(async (_tokens: OAuthTokens) => {});
  const provider = {
    clientInformation: vi.fn(async () => clientInformation),
  } as unknown as OAuthClientProvider;
  return {
    context: { serverUrl, provider, setIssuer, saveTokens, startupTimeoutMs: 12_345 },
    setIssuer,
    saveTokens,
  };
}

describe('requestTokenRefresh', () => {
  beforeEach(() => {
    createTimeoutFetchMock.mockReset();
    discoverAuthMock.mockReset();
    refreshAuthorizationMock.mockReset();
    // Sensible defaults so individual tests only override what they
    // assert against.
    createTimeoutFetchMock.mockReturnValue(BOUNDED_FETCH);
    discoverAuthMock.mockResolvedValue({
      serverMetadata: SERVER_METADATA,
      authorizationServerUrl: AS_URL,
      resourceMetadataDiscoveryFailed: false,
    });
    refreshAuthorizationMock.mockResolvedValue(FRESH_TOKENS);
  });

  it('throws without issuing a token request when Protected Resource Metadata discovery failed transiently', async () => {
    discoverAuthMock.mockResolvedValue({
      serverMetadata: SERVER_METADATA,
      authorizationServerUrl: AS_URL,
      resourceMetadataDiscoveryFailed: true,
    });
    const { context, saveTokens } = createContext(SERVER_URL, { client_id: 'reg-id' });

    await expect(requestTokenRefresh(context, 'stale-rt')).rejects.toThrow(
      /Protected Resource Metadata/,
    );

    // The server may bind tokens to a resource; issuing an unbound
    // refresh would earn the "not bound to this server" 401 class.
    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it('returns undefined without a server URL, server metadata, or client registration', async () => {
    // No server URL: nothing can be discovered or refreshed.
    const missingUrl = createContext(undefined, { client_id: 'reg-id' });
    await expect(requestTokenRefresh(missingUrl.context, 'stale-rt')).resolves.toBeUndefined();
    expect(discoverAuthMock).not.toHaveBeenCalled();
    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
    expect(missingUrl.saveTokens).not.toHaveBeenCalled();

    // No authorization server metadata: discovery found no OAuth.
    discoverAuthMock.mockResolvedValue({
      serverMetadata: undefined,
      authorizationServerUrl: AS_URL,
      resourceMetadataDiscoveryFailed: false,
    });
    const missingMetadata = createContext(SERVER_URL, { client_id: 'reg-id' });
    await expect(requestTokenRefresh(missingMetadata.context, 'stale-rt')).resolves.toBeUndefined();
    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
    expect(missingMetadata.saveTokens).not.toHaveBeenCalled();

    // No client registration: the token endpoint would reject the request.
    discoverAuthMock.mockResolvedValue({
      serverMetadata: SERVER_METADATA,
      authorizationServerUrl: AS_URL,
      resourceMetadataDiscoveryFailed: false,
    });
    const missingRegistration = createContext(SERVER_URL);
    await expect(
      requestTokenRefresh(missingRegistration.context, 'stale-rt'),
    ).resolves.toBeUndefined();
    expect(refreshAuthorizationMock).not.toHaveBeenCalled();
    expect(missingRegistration.saveTokens).not.toHaveBeenCalled();
  });

  it('sends the refresh with the discovered resource indicator and a bounded fetch, then saves the returned tokens', async () => {
    discoverAuthMock.mockResolvedValue({
      serverMetadata: SERVER_METADATA,
      authorizationServerUrl: AS_URL,
      resourceMetadata: RESOURCE_METADATA,
      resourceMetadataDiscoveryFailed: false,
    });
    const { context, setIssuer, saveTokens } = createContext(SERVER_URL, { client_id: 'reg-id' });

    const result = await requestTokenRefresh(context, 'stale-rt');

    expect(result).toEqual(FRESH_TOKENS);
    expect(refreshAuthorizationMock).toHaveBeenCalledTimes(1);
    const [authorizationServerUrl, options] = refreshAuthorizationMock.mock.calls[0]!;
    expect(authorizationServerUrl).toBe(AS_URL);
    expect(options).toEqual(
      expect.objectContaining({
        refreshToken: 'stale-rt',
        // The RFC 8707 resource indicator the server published in its
        // Protected Resource Metadata must reach the token request.
        resource: new URL(SERVER_URL),
      }),
    );
    // A hung token endpoint must not hold the caller forever: the
    // refresh must install the fetch built with the context's startup
    // budget, not the bare global fetch.
    expect(createTimeoutFetchMock).toHaveBeenCalledWith(12_345);
    expect(options.fetchFn).toBe(BOUNDED_FETCH);
    // The issuer is recorded so a stored entry from a different
    // authorization server is never reused.
    expect(setIssuer).toHaveBeenCalledWith(SERVER_METADATA.issuer);
    expect(saveTokens).toHaveBeenCalledWith(FRESH_TOKENS);
  });
});
