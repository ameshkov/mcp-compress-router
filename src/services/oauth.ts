import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { DownstreamServerConfig, StoredCredentials } from '../utils/index.js';
import { readCredentials, writeCredentials, removeCredentials } from '../cli/config-io.js';

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
    return `http://localhost:${this._actualPort}/callback`;
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
      tokens: creds?.tokens ?? { access_token: '', token_type: 'Bearer' },
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
   * Removes all stored credentials for this server (used by logout).
   */
  async clearTokens(): Promise<void> {
    this._codeVerifier = undefined;
    await removeCredentials(this._configPath, this._server.name);
  }

  private async _loadCredentials(): Promise<StoredCredentials | undefined> {
    const all = await readCredentials(this._configPath);
    return all[this._server.name];
  }
}
