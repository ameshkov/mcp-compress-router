import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { DownstreamServerConfig, StoredCredentials } from '../utils/index.js';
import { readCredentials, writeCredentials, removeCredentials } from '../cli/config-io.js';

/**
 * The OAuth redirect callback path served by the temporary local HTTP
 * server started during `login`. The full redirect URI is
 * `http://localhost:<port>/mcp-compress-router/oauth-callback`, where
 * `<port>` is assigned by the OS. Register this path (on `localhost`,
 * any port) with OAuth providers that require a pre-registered client.
 *
 * @internal Exported for tests only; not part of the public module API.
 *   The constant is consumed internally by `redirectUrl`; tests import
 *   it directly to avoid hardcoding the path string.
 */
export const OAUTH_CALLBACK_PATH = '/mcp-compress-router/oauth-callback';

/**
 * Implements OAuthClientProvider backed by credentials.json credential storage.
 *
 * Each instance manages credentials for one downstream server.
 * When `oauth` overrides are present in the server config, dynamic
 * client registration is skipped and static client info is used.
 */
export class OAuthCredentialManager implements OAuthClientProvider {
  private readonly _configPath: string;
  private readonly _server: DownstreamServerConfig;
  private _codeVerifier?: string;
  private _staticClientInfo?: OAuthClientInformationMixed;
  private _actualPort: number = 0;

  constructor(configPath: string, server: DownstreamServerConfig) {
    this._configPath = configPath;
    this._server = server;

    // If oauth overrides are present, set up static client info
    if (server.oauth?.clientId) {
      const info: OAuthClientInformationMixed = {
        client_id: server.oauth.clientId,
      };
      if (server.oauth.clientSecret) {
        info.client_secret = server.oauth.clientSecret;
      }
      this._staticClientInfo = info;
    }
  }

  get redirectUrl(): string | URL | undefined {
    // Return the callback URL with the actual port assigned by the OS.
    // Falls back to port 0 until setActualPort() is called by login-command.
    return `http://localhost:${this._actualPort}${OAUTH_CALLBACK_PATH}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl as string],
      client_name: 'mcp-compress-router',
    };
  }

  /**
   * Sets the actual listening port of the temporary HTTP callback server.
   * Must be called before startAuthorization so the redirect_uri is correct.
   *
   * @param port - The actual port the callback server is listening on.
   */
  setActualPort(port: number): void {
    this._actualPort = port;
  }

  /**
   * Whether this manager has static (override) client information,
   * bypassing dynamic client registration.
   */
  hasStaticClient(): boolean {
    return this._staticClientInfo !== undefined;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    // Static overrides take precedence
    if (this._staticClientInfo) {
      return this._staticClientInfo;
    }
    const creds = await this._loadCredentials();
    return creds?.clientRegistration as OAuthClientInformationMixed | undefined;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    if (this._staticClientInfo) {
      // Don't overwrite static overrides
      return;
    }
    const creds = await this._loadCredentials();
    const updated: StoredCredentials = {
      clientRegistration: clientInformation as Record<string, unknown>,
      // Preserve existing tokens; omit when none (tokens is optional).
      ...(creds?.tokens ? { tokens: creds.tokens } : {}),
      // Successful OAuth client registration proves the server supports
      // OAuth. Override any stale cached requirement.
      authRequirement: 'oauth',
      checkedAt: new Date().toISOString(),
    };
    await writeCredentials(this._configPath, this._server.name, updated);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const creds = await this._loadCredentials();
    if (!creds?.tokens?.access_token) {
      return undefined;
    }
    return creds.tokens as OAuthTokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const creds = await this._loadCredentials();
    const updated: StoredCredentials = {
      clientRegistration: creds?.clientRegistration,
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        scope: tokens.scope,
        token_type: tokens.token_type,
      },
      // A successful OAuth token exchange proves the server supports
      // OAuth. Override any stale cached requirement (e.g. 'none' from
      // a failed startup probe) with 'oauth'.
      authRequirement: 'oauth',
      checkedAt: new Date().toISOString(),
    };
    await writeCredentials(this._configPath, this._server.name, updated);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Open the authorization URL in the default browser.
    const { openBrowser } = await import('../utils/open-browser.js');
    await openBrowser(authorizationUrl.toString());
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this._codeVerifier = codeVerifier;
  }

  async codeVerifier(): Promise<string> {
    if (!this._codeVerifier) {
      throw new Error('No code verifier saved');
    }
    return this._codeVerifier;
  }

  /**
   * Removes stored OAuth tokens and client registration for this server
   * (used by logout). Preserves the cached auth requirement so the
   * `list` command still shows the correct status (e.g. "requires
   * login") after logout. When there is no cached auth requirement to
   * keep, the entire entry is removed (and the credentials file deleted
   * when it becomes empty).
   */
  async clearTokens(): Promise<void> {
    this._codeVerifier = undefined;
    const creds = await this._loadCredentials();
    if (creds?.authRequirement) {
      await writeCredentials(this._configPath, this._server.name, {
        authRequirement: creds.authRequirement,
        checkedAt: creds.checkedAt,
      });
      return;
    }
    await removeCredentials(this._configPath, this._server.name);
  }

  private async _loadCredentials(): Promise<StoredCredentials | undefined> {
    const all = await readCredentials(this._configPath);
    return all[this._server.name];
  }
}
