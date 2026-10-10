import { describe, it, expect, afterEach, vi } from 'vitest';
import { OAuthCredentialManager } from '../services/oauth.js';
import { acquireAuthorizationCode, type AuthResult } from './login-callback-server.js';
import type { PasteReader } from './login-paste.js';
import { resolveServerTimeouts } from '../utils/index.js';
import type { DownstreamServerConfig } from '../utils/types.js';

const server: DownstreamServerConfig = {
  name: 'test-server',
  description: 'Test OAuth server',
  type: 'http',
  url: 'https://example.com/mcp',
  timeout: resolveServerTimeouts(),
};

/** Captures what `beginAuthorization` observes once the port is bound. */
interface Captured {
  redirectUrl: string;
  state: string;
}

/**
 * Starts a flow whose hook captures the redirect URL and state, and whose
 * browser is a no-op (the test delivers the callback itself). Tests can
 * override the browser, the manual reader, and the output callbacks.
 */
function startFlow(input: {
  captured: Partial<Captured>;
  expectedIssuer?: string;
  requireIssuer?: boolean;
  codeVerifier?: string;
  noBrowser?: boolean;
  openBrowser?: (url: string) => Promise<void>;
  onAuthorizationUrl?: (url: string) => void;
  onNotice?: (message: string) => void;
  getManualReader?: () => Pick<PasteReader, 'readLine'> | undefined;
}): Promise<{ authorizationCode: string; authResult: AuthResult }> {
  const mgr = new OAuthCredentialManager('/nonexistent/mcp.json', server);
  return acquireAuthorizationCode({
    mgr,
    callbackPort: 0,
    openBrowser: input.openBrowser ?? (async () => {}),
    expectedIssuer: input.expectedIssuer ?? 'https://as.example',
    requireIssuer: input.requireIssuer ?? false,
    noBrowser: input.noBrowser,
    onAuthorizationUrl: input.onAuthorizationUrl ?? (() => {}),
    onNotice: input.onNotice ?? (() => {}),
    getManualReader: input.getManualReader,
    beginAuthorization: async (state) => {
      input.captured.state = state;
      input.captured.redirectUrl = mgr.redirectUrl as string;
      return {
        authorizationUrl: new URL('https://as.example/authorize'),
        codeVerifier: input.codeVerifier ?? 'test-verifier',
      };
    },
  });
}

/** Waits until the callback server is bound and the hook has run. */
async function waitForSetup(captured: Partial<Captured>): Promise<Captured> {
  await vi.waitFor(() => {
    expect(captured.redirectUrl).toBeDefined();
    expect(captured.state).toBeDefined();
  });
  return captured as Captured;
}

/** Builds a callback URL with the given query parameters. */
function callbackUrl(captured: Captured, params: Record<string, string>): string {
  const url = new URL(captured.redirectUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

describe('acquireAuthorizationCode', () => {
  const originalTimeout = process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS;

  afterEach(() => {
    if (originalTimeout === undefined) {
      delete process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS;
    } else {
      process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS = originalTimeout;
    }
  });

  it('binds the loopback port before beginAuthorization and resolves on a valid callback', async () => {
    const captured: Partial<Captured> = {};
    const pending = startFlow({ captured });
    const setup = await waitForSetup(captured);

    // The hook must run after setActualPort, so the redirect URL carries
    // the bound loopback port, and a CSRF state was generated for it.
    const redirect = new URL(setup.redirectUrl);
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(Number(redirect.port)).toBeGreaterThan(0);
    expect(setup.state).not.toBe('');

    const response = await fetch(callbackUrl(setup, { code: 'code-123', state: setup.state }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");

    const body = await response.text();
    expect(body).toContain('Authorization successful');
    expect(body).toContain('mcp-compress-router');

    const result = await pending;
    expect(result.authorizationCode).toBe('code-123');
    expect(result.authResult.codeVerifier).toBe('test-verifier');
  });

  it('ignores a callback whose state does not match and still accepts the valid one', async () => {
    const captured: Partial<Captured> = {};
    const pending = startFlow({ captured });
    const setup = await waitForSetup(captured);

    // A stray response must not settle the flow: the legitimate callback
    // still arrives and completes it.
    const ignored = await fetch(callbackUrl(setup, { code: 'code-123', state: 'wrong-state' }));
    expect(ignored.status).toBe(400);

    const response = await fetch(callbackUrl(setup, { code: 'code-123', state: setup.state }));
    expect(response.status).toBe(200);

    await expect(pending).resolves.toMatchObject({ authorizationCode: 'code-123' });
  });

  it('ignores a callback without state and still accepts the valid one', async () => {
    const captured: Partial<Captured> = {};
    const pending = startFlow({ captured });
    const setup = await waitForSetup(captured);

    const ignored = await fetch(callbackUrl(setup, { code: 'code-123' }));
    expect(ignored.status).toBe(400);

    const response = await fetch(callbackUrl(setup, { code: 'code-123', state: setup.state }));
    expect(response.status).toBe(200);

    await expect(pending).resolves.toMatchObject({ authorizationCode: 'code-123' });
  });

  it('ignores a callback whose iss does not match the expected issuer', async () => {
    const captured: Partial<Captured> = {};
    const pending = startFlow({ captured, expectedIssuer: 'https://as.example' });
    const setup = await waitForSetup(captured);

    const ignored = await fetch(
      callbackUrl(setup, { code: 'code-123', state: setup.state, iss: 'https://evil.example' }),
    );
    expect(ignored.status).toBe(400);

    const response = await fetch(
      callbackUrl(setup, { code: 'code-123', state: setup.state, iss: 'https://as.example' }),
    );
    expect(response.status).toBe(200);

    await expect(pending).resolves.toMatchObject({ authorizationCode: 'code-123' });
  });

  it('ignores a missing iss when the server advertises RFC 9207 support', async () => {
    const captured: Partial<Captured> = {};
    const pending = startFlow({ captured, requireIssuer: true });
    const setup = await waitForSetup(captured);

    const ignored = await fetch(callbackUrl(setup, { code: 'code-123', state: setup.state }));
    expect(ignored.status).toBe(400);

    const response = await fetch(
      callbackUrl(setup, { code: 'code-123', state: setup.state, iss: 'https://as.example' }),
    );
    expect(response.status).toBe(200);

    await expect(pending).resolves.toMatchObject({ authorizationCode: 'code-123' });
  });

  it('accepts a matching iss when RFC 9207 support is advertised', async () => {
    const captured: Partial<Captured> = {};
    const pending = startFlow({
      captured,
      expectedIssuer: 'https://as.example',
      requireIssuer: true,
    });
    const setup = await waitForSetup(captured);

    const response = await fetch(
      callbackUrl(setup, {
        code: 'code-456',
        state: setup.state,
        iss: 'https://as.example',
      }),
    );
    expect(response.status).toBe(200);

    await expect(pending).resolves.toMatchObject({ authorizationCode: 'code-456' });
  });

  it('rejects a matching-state error callback with the authorization error', async () => {
    const captured: Partial<Captured> = {};
    const pending = startFlow({ captured });
    const rejection = expect(pending).rejects.toThrow(/Authorization failed: access_denied/);
    const setup = await waitForSetup(captured);

    const response = await fetch(
      callbackUrl(setup, {
        error: 'access_denied',
        error_description: 'The user denied the request',
        state: setup.state,
      }),
    );
    expect(response.status).toBe(400);

    // The failure page shows the error code and, when the authorization
    // server provides one, the human-readable description.
    const body = await response.text();
    expect(body).toContain('<code>access_denied</code>');
    expect(body).toContain('The user denied the request');

    await rejection;
  });

  it('ignores an error callback whose state does not match and still accepts the valid one', async () => {
    const captured: Partial<Captured> = {};
    const pending = startFlow({ captured });
    const setup = await waitForSetup(captured);

    // A forged error response must not abort the login.
    const ignored = await fetch(
      callbackUrl(setup, { error: 'access_denied', state: 'wrong-state' }),
    );
    expect(ignored.status).toBe(400);

    const response = await fetch(callbackUrl(setup, { code: 'code-123', state: setup.state }));
    expect(response.status).toBe(200);

    await expect(pending).resolves.toMatchObject({ authorizationCode: 'code-123' });
  });

  it('escapes the authorization error text on the callback page', async () => {
    const captured: Partial<Captured> = {};
    const pending = startFlow({ captured });
    const rejection = expect(pending).rejects.toThrow(/Authorization failed/);
    const setup = await waitForSetup(captured);

    const response = await fetch(
      callbackUrl(setup, {
        error: '<script>alert(1)</script>',
        error_description: '<script>alert(2)</script>',
        state: setup.state,
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(body).not.toContain('<script>');

    await rejection;
  });

  it('rejects when beginAuthorization fails', async () => {
    const mgr = new OAuthCredentialManager('/nonexistent/mcp.json', server);
    await expect(
      acquireAuthorizationCode({
        mgr,
        callbackPort: 0,
        openBrowser: async () => {},
        expectedIssuer: 'https://as.example',
        requireIssuer: false,
        beginAuthorization: async () => {
          throw new Error('client registration failed');
        },
      }),
    ).rejects.toThrow('client registration failed');
  });

  it('rejects when the callback does not arrive before the timeout', async () => {
    process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS = '100';
    const captured: Partial<Captured> = {};
    const pending = startFlow({ captured });
    await waitForSetup(captured);

    await expect(pending).rejects.toThrow(/timed out/);
  });

  it('prints the authorization URL before opening the browser', async () => {
    const captured: Partial<Captured> = {};
    const onAuthorizationUrl = vi.fn();
    const openBrowser = vi.fn(async () => {});
    const pending = startFlow({ captured, onAuthorizationUrl, openBrowser });
    const setup = await waitForSetup(captured);

    await vi.waitFor(() => {
      expect(onAuthorizationUrl).toHaveBeenCalledWith('https://as.example/authorize');
      expect(openBrowser).toHaveBeenCalledWith('https://as.example/authorize');
    });
    expect(onAuthorizationUrl.mock.invocationCallOrder[0]).toBeLessThan(
      openBrowser.mock.invocationCallOrder[0]!,
    );

    await fetch(callbackUrl(setup, { code: 'code-print', state: setup.state }));
    await expect(pending).resolves.toMatchObject({ authorizationCode: 'code-print' });
  });

  it('skips the browser and settles with a pasted code when noBrowser is set', async () => {
    const captured: Partial<Captured> = {};
    const openBrowser = vi.fn(async () => {});
    const pending = startFlow({
      captured,
      noBrowser: true,
      openBrowser,
      getManualReader: () => ({ readLine: async () => 'pasted-code' }),
    });
    await waitForSetup(captured);

    await expect(pending).resolves.toMatchObject({ authorizationCode: 'pasted-code' });
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it('falls back to the paste prompt when the browser fails to launch', async () => {
    const captured: Partial<Captured> = {};
    const onNotice = vi.fn();
    const pending = startFlow({
      captured,
      openBrowser: async () => {
        throw new Error('spawn xdg-open ENOENT');
      },
      onNotice,
      getManualReader: () => ({
        readLine: async () => {
          const url = new URL(captured.redirectUrl!);
          url.searchParams.set('code', 'pasted-after-failure');
          url.searchParams.set('state', captured.state!);
          return url.toString();
        },
      }),
    });
    await waitForSetup(captured);

    await expect(pending).resolves.toMatchObject({ authorizationCode: 'pasted-after-failure' });
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('Could not open a browser'));
  });

  it('re-prompts when a pasted redirect URL fails state validation', async () => {
    const captured: Partial<Captured> = {};
    const onNotice = vi.fn();
    const inputs = [
      () => {
        const url = new URL(captured.redirectUrl!);
        url.searchParams.set('code', 'stale-code');
        url.searchParams.set('state', 'wrong-state');
        return url.toString();
      },
      () => {
        const url = new URL(captured.redirectUrl!);
        url.searchParams.set('code', 'good-code');
        url.searchParams.set('state', captured.state!);
        return url.toString();
      },
    ];
    const readLine = vi.fn(async () => inputs.shift()!());
    const pending = startFlow({
      captured,
      noBrowser: true,
      onNotice,
      getManualReader: () => ({ readLine }),
    });
    await waitForSetup(captured);

    await expect(pending).resolves.toMatchObject({ authorizationCode: 'good-code' });
    expect(readLine).toHaveBeenCalledTimes(2);
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('state mismatch'));
  });

  it('rejects a pasted error response whose state matches', async () => {
    const captured: Partial<Captured> = {};
    const pending = startFlow({
      captured,
      noBrowser: true,
      getManualReader: () => ({
        readLine: async () => {
          const url = new URL(captured.redirectUrl!);
          url.searchParams.set('error', 'access_denied');
          url.searchParams.set('error_description', 'The user denied the request');
          url.searchParams.set('state', captured.state!);
          return url.toString();
        },
      }),
    });
    const rejection = expect(pending).rejects.toThrow(/Authorization failed: access_denied/);
    await waitForSetup(captured);

    await rejection;
  });

  it('cancels the login when the paste reader reports end-of-input', async () => {
    const captured: Partial<Captured> = {};
    const pending = startFlow({
      captured,
      noBrowser: true,
      getManualReader: () => ({ readLine: async () => undefined }),
    });
    const rejection = expect(pending).rejects.toThrow(/cancelled/);
    await waitForSetup(captured);

    await rejection;
  });

  it('accepts the loopback callback while the paste prompt is still open', async () => {
    const captured: Partial<Captured> = {};
    const pending = startFlow({
      captured,
      noBrowser: true,
      getManualReader: () => ({ readLine: () => new Promise<string | undefined>(() => {}) }),
    });
    const setup = await waitForSetup(captured);

    await fetch(callbackUrl(setup, { code: 'callback-code', state: setup.state }));
    await expect(pending).resolves.toMatchObject({ authorizationCode: 'callback-code' });
  });

  it('falls back to the callback timeout without an interactive reader', async () => {
    process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS = '100';
    const captured: Partial<Captured> = {};
    const pending = startFlow({ captured, noBrowser: true });
    const rejection = expect(pending).rejects.toThrow(/timed out/);
    await waitForSetup(captured);

    await rejection;
  });
});
