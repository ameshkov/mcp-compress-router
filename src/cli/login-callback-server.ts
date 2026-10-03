import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { OAuthCredentialManager } from '../services/oauth.js';
import { renderCallbackPage } from './login-callback-page.js';

/**
 * SDK `startAuthorization` result: the authorization URL to open in the
 * browser and the PKCE code verifier to present at the token endpoint.
 */
export type AuthResult = Awaited<
  ReturnType<(typeof import('@modelcontextprotocol/sdk/client/auth.js'))['startAuthorization']>
>;

/** Mutable timeout slot shared between the listen callback and the handler. */
type TimeoutHandle = { current: ReturnType<typeof setTimeout> | undefined };

/** Inputs for {@link acquireAuthorizationCode}. */
interface AcquireAuthorizationCodeOptions {
  /** Credential manager whose `redirectUrl` is fixed once the port is bound. */
  mgr: OAuthCredentialManager;
  /** Port to bind the temporary callback server on (0 = OS-assigned). */
  callbackPort: number;
  /** Opens the authorization URL in the user's browser. */
  openBrowser: (url: string) => Promise<void>;
  /** Authorization-server issuer identifier (the `issuer` in AS metadata). */
  expectedIssuer: string;
  /**
   * Whether a callback without an `iss` parameter must be rejected. Set
   * when the authorization server advertises
   * `authorization_response_iss_parameter_supported` (RFC 9207), which
   * commits it to include `iss` in every authorization response.
   */
  requireIssuer: boolean;
  /**
   * Registers the OAuth client if needed and builds the authorization URL
   * for the given `state`. Invoked after the callback server has bound its
   * port and `setActualPort` has recorded it, so the authorization request
   * carries the real redirect URI instead of the port-0 fallback. Client
   * registration does not need the port: it registers the portless
   * loopback URI (RFC 8252 §8.4).
   */
  beginAuthorization: (state: string) => Promise<AuthResult>;
}

/** Result of a successful interactive authorization round-trip. */
interface AuthorizationCodeResult {
  /** Authorization code delivered to the loopback callback. */
  authorizationCode: string;
  /** `startAuthorization` result produced for this login. */
  authResult: AuthResult;
}

/** Shared state for one callback-server lifecycle. */
interface CallbackFlow {
  options: AcquireAuthorizationCodeOptions;
  /** CSRF state generated for this login and echoed back by the server. */
  state: string;
  timeoutMs: number;
  timeoutHandle: TimeoutHandle;
  authResultRef: { value: AuthResult | undefined };
}

/**
 * Starts a temporary loopback HTTP server on `callbackPort`, runs the
 * authorization-code flow through `beginAuthorization`, and waits for the
 * browser redirect carrying the authorization code. The callback must echo
 * the generated `state`; when it carries `iss`, the value must match the
 * expected authorization-server issuer.
 *
 * The callback timeout comes from `MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS`
 * (default 120 seconds).
 *
 * @param options - Callback server inputs.
 * @returns The authorization code and the `startAuthorization` result.
 * @throws If the server cannot bind, `beginAuthorization` fails, the
 *   authorization server redirects with an `error`, or the callback does
 *   not arrive before the timeout. A callback that fails state or issuer
 *   validation is ignored — it never settles the flow, so it surfaces as
 *   a timeout instead.
 */
export async function acquireAuthorizationCode(
  options: AcquireAuthorizationCodeOptions,
): Promise<AuthorizationCodeResult> {
  return startCallbackServerAndWait({
    options,
    state: randomBytes(32).toString('base64url'),
    timeoutMs: readTimeoutMs(),
    timeoutHandle: { current: undefined },
    authResultRef: { value: undefined },
  });
}

/**
 * Reads the OAuth login timeout from the
 * `MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS` env var, defaulting to 120 seconds.
 *
 * @returns Timeout in milliseconds.
 */
function readTimeoutMs(): number {
  const env = process.env.MCP_COMPRESS_ROUTER_LOGIN_TIMEOUT_MS;
  if (env) {
    const parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 120_000;
}

/**
 * Creates the temporary HTTP server, binds it to the loopback interface,
 * and resolves with the authorization code once the browser delivers the
 * callback.
 *
 * @param flow - Callback flow state for this login attempt.
 * @returns The authorization code and the `startAuthorization` result.
 */
async function startCallbackServerAndWait(flow: CallbackFlow): Promise<AuthorizationCodeResult> {
  const authorizationCode = await new Promise<string>((resolve, reject) => {
    const tempServer = http.createServer();
    tempServer.on('request', makeCallbackHandler(flow, tempServer, resolve, reject));

    tempServer.listen(
      flow.options.callbackPort,
      '127.0.0.1',
      onServerListen(flow, tempServer, reject),
    );

    tempServer.on('error', (err) => {
      if (flow.timeoutHandle.current) clearTimeout(flow.timeoutHandle.current);
      reject(err);
    });
  });

  if (flow.timeoutHandle.current) clearTimeout(flow.timeoutHandle.current);

  return { authorizationCode, authResult: flow.authResultRef.value! };
}

/**
 * Validates the callback query against the login attempt: the CSRF
 * `state` must match, and a present `iss` must equal the expected
 * authorization-server issuer (a missing `iss` fails validation when the
 * server advertised RFC 9207 support).
 *
 * @param flow - Callback flow state for this login attempt.
 * @param url - The parsed callback URL.
 * @returns An error message when the callback must be ignored, or
 *   undefined when it is valid.
 */
function validateCallback(flow: CallbackFlow, url: URL): string | undefined {
  if (url.searchParams.get('state') !== flow.state) {
    return 'OAuth callback state mismatch: the response does not belong to this login attempt.';
  }

  const iss = url.searchParams.get('iss');
  if (iss !== null && iss !== flow.options.expectedIssuer) {
    return `OAuth callback issuer mismatch: expected "${flow.options.expectedIssuer}", received "${iss}".`;
  }
  if (iss === null && flow.options.requireIssuer) {
    return 'OAuth callback is missing the issuer parameter (iss) advertised by the authorization server.';
  }

  return undefined;
}

/**
 * Response headers for every callback page: self-contained HTML plus a
 * strict CSP. The pages load no scripts and no external resources; the
 * policy is defense in depth behind the renderer's HTML escaping.
 */
const PAGE_HEADERS: http.OutgoingHttpHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
};

/**
 * Writes one callback page response.
 *
 * @param res - The server response.
 * @param status - HTTP status code.
 * @param html - The complete page document.
 */
function sendPage(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, PAGE_HEADERS);
  res.end(html);
}

/**
 * Responds with the failure page for a callback that failed validation
 * (a stray or forged request that must not settle the flow).
 *
 * @param res - The server response.
 */
function respondInvalidCallback(res: http.ServerResponse): void {
  sendPage(
    res,
    400,
    renderCallbackPage({
      kind: 'error',
      heading: 'Authorization failed',
      message: 'Invalid OAuth callback.',
    }),
  );
}

/**
 * Responds with the failure page for an authorization error, showing the
 * OAuth error code and, when provided, the server's description.
 *
 * @param res - The server response.
 * @param error - The OAuth error code from the callback.
 * @param description - The OAuth `error_description`, or null.
 */
function respondAuthorizationError(
  res: http.ServerResponse,
  error: string,
  description: string | null,
): void {
  sendPage(
    res,
    400,
    renderCallbackPage({
      kind: 'error',
      heading: 'Authorization failed',
      message: description ?? 'The authorization server rejected the request.',
      detail: error,
    }),
  );
}

/**
 * Responds with the success page after a valid callback.
 *
 * @param res - The server response.
 */
function respondSuccess(res: http.ServerResponse): void {
  sendPage(
    res,
    200,
    renderCallbackPage({
      kind: 'success',
      heading: 'Authorization successful',
      message: 'You can close this window and return to your terminal.',
    }),
  );
}

/**
 * Settles the flow with a failure: clears the callback timeout, closes
 * the temporary server, and rejects the pending promise.
 *
 * @param flow - Callback flow state for this login attempt.
 * @param tempServer - The temporary callback server (closed on failure).
 * @param reject - Promise reject function.
 * @param message - The error message for the rejection.
 */
function failFlow(
  flow: CallbackFlow,
  tempServer: http.Server,
  reject: (err: Error) => void,
  message: string,
): void {
  if (flow.timeoutHandle.current) clearTimeout(flow.timeoutHandle.current);
  tempServer.close();
  reject(new Error(message));
}

/**
 * Handles one callback request: validates the CSRF `state` echoed by the
 * authorization server and, when present, the RFC 9207 `iss` issuer
 * parameter before acting on the callback. A callback that fails
 * validation is ignored: it gets a 400 response but never settles the
 * flow, so a stray loopback request cannot abort a login whose
 * legitimate callback is still on its way.
 *
 * @param flow - Callback flow state for this login attempt.
 * @param tempServer - The temporary callback server (closed on completion).
 * @param resolve - Promise resolve function (authorization code).
 * @param reject - Promise reject function.
 * @param req - The incoming request.
 * @param res - The server response.
 */
function handleCallbackRequest(
  flow: CallbackFlow,
  tempServer: http.Server,
  resolve: (code: string) => void,
  reject: (err: Error) => void,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const url = new URL(req.url!, `http://127.0.0.1`);
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');

  // Only authorization responses (a code or an error) carry a state to
  // validate; anything else is not a callback.
  if (error !== null || code !== null) {
    const validationError = validateCallback(flow, url);
    if (validationError) {
      respondInvalidCallback(res);
      return;
    }
  }

  if (error !== null) {
    respondAuthorizationError(res, error, url.searchParams.get('error_description'));
    failFlow(flow, tempServer, reject, `Authorization failed: ${error}`);
    return;
  }

  if (code === null) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  if (flow.timeoutHandle.current) clearTimeout(flow.timeoutHandle.current);
  respondSuccess(res);
  tempServer.close();
  resolve(code);
}

/**
 * Creates the HTTP request listener for the temporary callback server.
 *
 * @param flow - Callback flow state for this login attempt.
 * @param tempServer - The temporary callback server (closed on completion).
 * @param resolve - Promise resolve function (authorization code).
 * @param reject - Promise reject function.
 * @returns An HTTP request listener.
 */
function makeCallbackHandler(
  flow: CallbackFlow,
  tempServer: http.Server,
  resolve: (code: string) => void,
  reject: (err: Error) => void,
): http.RequestListener {
  return (req, res) => handleCallbackRequest(flow, tempServer, resolve, reject, req, res);
}

/**
 * Listen callback: records the bound port, prepares the authorization
 * request, opens the browser, and arms the callback timeout. Closes the
 * listener when preparation fails so the process is not kept alive while
 * the error is reported.
 *
 * @param flow - Callback flow state for this login attempt.
 * @param tempServer - The temporary callback server.
 * @param reject - Promise reject function.
 * @returns The async listen handler.
 */
function onServerListen(
  flow: CallbackFlow,
  tempServer: http.Server,
  reject: (err: Error) => void,
): () => Promise<void> {
  return async () => {
    try {
      const address = tempServer.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to get server address');
      }

      // Record the OS-assigned port before the authorization request, so
      // it (and the token exchange that follows) carries the real
      // redirect URI.
      flow.options.mgr.setActualPort(address.port);

      flow.authResultRef.value = await flow.options.beginAuthorization(flow.state);
      await flow.options.mgr.saveCodeVerifier(flow.authResultRef.value.codeVerifier);

      void flow.options.openBrowser(flow.authResultRef.value.authorizationUrl.toString());

      flow.timeoutHandle.current = setTimeout(() => {
        tempServer.close();
        reject(
          new Error(
            `OAuth login timed out after ${flow.timeoutMs / 1000} seconds. Please try again.`,
          ),
        );
      }, flow.timeoutMs);
    } catch (err) {
      // Close the listener so a failed setup cannot keep the CLI process
      // alive while the error is reported.
      tempServer.close();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
}
