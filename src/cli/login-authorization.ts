import type { DownstreamServerConfig } from '../utils/index.js';
import { buildLoginCommand, buildLogoutCommand } from '../utils/index.js';
import { isInvalidClientError } from '../services/index.js';
import { OAUTH_LOOPBACK_URI } from '../services/oauth.js';
import type { OAuthCredentialManager } from '../services/oauth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthResult } from './login-callback-server.js';
import { getSdkAuth, type OAuthMetadata } from './login-sdk.js';

/**
 * Whether a stored client registration covers the portless loopback
 * redirect URI. The comparison ignores the port (RFC 8252 §8.4 excludes
 * it from loopback redirect matching) but requires the scheme, host, and
 * path to match, so a registration for a different host (e.g.
 * `localhost`) is not reused.
 *
 * @param client - The stored client registration.
 * @returns True when at least one registered redirect URI matches
 *   {@link OAUTH_LOOPBACK_URI} ignoring the port.
 */
function registrationCoversLoopback(client: OAuthClientInformationMixed): boolean {
  if (!('redirect_uris' in client) || client.redirect_uris.length === 0) {
    return false;
  }
  const expected = new URL(OAUTH_LOOPBACK_URI);
  return client.redirect_uris.some((entry) => {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      return false;
    }
    return (
      parsed.protocol === expected.protocol &&
      parsed.hostname === expected.hostname &&
      parsed.pathname === expected.pathname
    );
  });
}

/**
 * Whether a stored client registration can be reused for this login.
 *
 * The registered redirect URIs must cover the portless loopback callback
 * URI (see {@link registrationCoversLoopback}). When the server
 * configures a `client_name` or `client_uri` override, the stored
 * registration must carry the same value for that field. Identity fields
 * the stored registration does not contain are ignored: legacy
 * registrations (and providers that do not echo the metadata) stay
 * reusable instead of being re-registered on every login.
 *
 * @param client - The stored client registration.
 * @param server - The effective downstream server configuration.
 * @returns True when the stored registration can be reused as-is.
 */
function registrationMatches(
  client: OAuthClientInformationMixed,
  server: DownstreamServerConfig,
): boolean {
  if (!registrationCoversLoopback(client)) {
    return false;
  }
  const { clientName, clientUri } = server.oauth ?? {};
  if (clientName !== undefined && 'client_name' in client && client.client_name !== clientName) {
    return false;
  }
  if (clientUri !== undefined && 'client_uri' in client && client.client_uri !== clientUri) {
    return false;
  }
  return true;
}

/**
 * Registers a client through dynamic client registration (RFC 7591) unless
 * a static `oauth.clientId` override is configured or a stored registration
 * matches the loopback redirect URI and the configured client identity.
 * Registration does not depend on the callback port: the registered URI is
 * the portless {@link OAUTH_LOOPBACK_URI}, and RFC 8252 §8.4 excludes the
 * port from loopback redirect matching.
 *
 * @param mgr - OAuth credential manager for the target server.
 * @param metadata - Discovered OAuth metadata.
 * @param name - Server name (for error messages).
 * @param server - The effective downstream server configuration (config
 *   plus any `login` overrides), used for the identity comparison.
 * @throws If the server does not support dynamic client registration and no
 *   reusable registration or static client is available.
 */
async function registerClientIfNeeded(
  mgr: OAuthCredentialManager,
  metadata: OAuthMetadata,
  name: string,
  server: DownstreamServerConfig,
): Promise<void> {
  if (mgr.hasStaticClient()) {
    return;
  }
  const stored = await mgr.clientInformation();
  if (stored && registrationMatches(stored, server)) {
    return;
  }
  if (!metadata.registration_endpoint) {
    throw new Error(
      `Server "${name}" does not support dynamic client registration. Configure an "oauth.clientId" override in mcp.json with a pre-registered client ID.`,
    );
  }
  const { registerClient } = await getSdkAuth();
  const registration = await registerClient(new URL(metadata.registration_endpoint), {
    metadata,
    clientMetadata: mgr.clientMetadata,
  });
  await mgr.saveClientInformation(registration);
}

/**
 * Formats the authorization server's `invalid_client` description for a
 * user-facing error message.
 *
 * @param description - The provider's error description, if any.
 * @returns The description prefixed with a colon and a space, or an empty
 *   string when the description is absent or empty.
 */
function invalidClientDetail(description: string | undefined): string {
  return description ? `: ${description}` : '';
}

/**
 * Builds the message for the configured OAuth client the authorization
 * server rejected with `invalid_client` at the token endpoint.
 *
 * @param name - Server name.
 * @param description - The provider's error description, if any.
 * @returns The complete error message.
 */
function rejectedClientMessage(name: string, description: string | undefined): string {
  const detail = invalidClientDetail(description);
  return `Server "${name}" rejected the configured OAuth client id (invalid_client${detail}). Check "oauth.clientId" and "oauth.clientSecret" in mcp.json.`;
}

/**
 * Registers the client if needed and builds the authorization URL. Passed to
 * the callback server as its post-listen hook, so it runs once the real
 * callback port is known and the authorization request carries it.
 *
 * A stored dynamic client registration is reused after the local checks
 * only. The authorization endpoint is not probed: the browser page is
 * outside the CLI's control, so a provider that rejects the client there
 * cannot be observed here. The runtime token-refresh path is the
 * recovery point: it discards a registration the token endpoint reports
 * as `invalid_client`.
 *
 * @param mgr - OAuth credential manager for the target server.
 * @param metadata - Discovered OAuth metadata.
 * @param targetServer - Typed downstream server configuration.
 * @param name - Server name (for error messages).
 * @param state - CSRF state generated for this login attempt.
 * @param resource - RFC 8707 resource indicator selected from the
 *   server's Protected Resource Metadata, or undefined when the server
 *   publishes none (the SDK then omits the `resource` parameter).
 * @returns The `startAuthorization` result.
 * @throws If the registration endpoint is unavailable and no reusable
 *   registration or static client exists.
 */
export async function beginAuthorization(
  mgr: OAuthCredentialManager,
  metadata: OAuthMetadata,
  targetServer: DownstreamServerConfig,
  name: string,
  state: string,
  resource: URL | undefined,
): Promise<AuthResult> {
  await registerClientIfNeeded(mgr, metadata, name, targetServer);
  const clientInformation = (await mgr.clientInformation())!;
  const { startAuthorization } = await getSdkAuth();
  return startAuthorization(new URL(metadata.authorization_endpoint!), {
    metadata,
    clientInformation,
    redirectUrl: mgr.redirectUrl as string,
    scope: targetServer.oauth?.scope,
    state,
    resource,
  });
}

/**
 * Inputs for one authorization-code token exchange.
 */
export interface AuthorizationCodeExchange {
  /** Authorization code delivered to the loopback callback. */
  authorizationCode: string;
  /** PKCE verifier generated for this authorization request. */
  codeVerifier: string;
  /** Redirect URI sent with the authorization request. */
  redirectUri: string;
  /** RFC 8707 resource indicator, when the server publishes one. */
  resource: URL | undefined;
}

/**
 * Exchanges the authorization code for tokens, discarding the stored
 * dynamic client registration when the token endpoint rejects it with
 * `invalid_client`.
 *
 * A provider that validates the client only at the token endpoint leaves
 * a dead registration on disk unless this path clears it, and every
 * later login would repeat the same failure. When the discard succeeds,
 * running `login` again registers a new client. When the discard fails,
 * the guided error tells the user to run `logout` first: a later login
 * only reuses the registration after local checks and does not probe the
 * provider, so the retained registration stays unusable.
 *
 * @param mgr - OAuth credential manager for the target server.
 * @param metadata - Discovered OAuth metadata.
 * @param name - Server name (for error messages).
 * @param exchange - The authorization code and request parameters.
 * @returns The issued tokens.
 * @throws The original token-endpoint error, or a guided error. A
 *   rejected configured client names `oauth.clientId` and
 *   `oauth.clientSecret`, a rejected stored registration names the
 *   `login` command to run again, or the `logout` and `login` commands
 *   when the registration could not be removed. A stored registration
 *   that disappeared during the interactive wait names only the `login`
 *   command, because nothing is left to remove. The guided error keeps
 *   the provider rejection as its `cause`.
 */
export async function exchangeAuthorizationCode(
  mgr: OAuthCredentialManager,
  metadata: OAuthMetadata,
  name: string,
  exchange: AuthorizationCodeExchange,
): Promise<OAuthTokens> {
  const clientInformation = await mgr.clientInformation();
  if (clientInformation === undefined) {
    // Another process shared this credentials file and removed the
    // registration while this login waited for authorization. There is
    // nothing to discard: guide the user to a fresh login.
    throw new Error(
      `Server "${name}" has no stored OAuth client registration to finish the login. Run "${buildLoginCommand(name)}" to register a new client and authorize this server.`,
    );
  }
  try {
    const { exchangeAuthorization } = await getSdkAuth();
    return await exchangeAuthorization(new URL(metadata.token_endpoint!), {
      metadata,
      clientInformation,
      authorizationCode: exchange.authorizationCode,
      codeVerifier: exchange.codeVerifier,
      redirectUri: exchange.redirectUri,
      resource: exchange.resource,
    });
  } catch (err) {
    if (!isInvalidClientError(err)) {
      throw err;
    }
    const description = err instanceof Error ? err.message : undefined;
    const detail = invalidClientDetail(description);
    if (mgr.hasStaticClient()) {
      throw new Error(rejectedClientMessage(name, description), { cause: err });
    }
    let discardFailure: string | undefined;
    try {
      await mgr.discardClientRegistration(clientInformation.client_id);
    } catch (cleanupError) {
      discardFailure = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    }
    if (discardFailure !== undefined) {
      // The provider rejection stays the cause. A later login only
      // reuses the registration after local checks and does not probe
      // the provider, so the retained registration must be cleared with
      // `logout` first.
      throw new Error(
        `Server "${name}" rejected the stored OAuth client registration (invalid_client${detail}). The rejected registration could not be removed: ${discardFailure}. Run "${buildLogoutCommand(name)}" and then "${buildLoginCommand(name)}" to register a new client.`,
        { cause: err },
      );
    }
    throw new Error(
      `Server "${name}" rejected the stored OAuth client registration (invalid_client${detail}). Run "${buildLoginCommand(name)}" again to register a new client.`,
      { cause: err },
    );
  }
}
