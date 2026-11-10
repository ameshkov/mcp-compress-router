import type { OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { DownstreamServerConfig, StoredCredentials } from '../utils/index.js';
import { mutateCredentials } from '../cli/config-io.js';
import { bindingFieldsFor, credentialsUsableFor } from './credential-binding.js';
import { tokensNeedInvalidation } from './oauth-token-refresh.js';

/**
 * Which stored OAuth state an invalidation request removes:
 *
 * - `'client'` — the dynamic client registration, keeping the tokens.
 * - `'tokens'` — the tokens, keeping the client registration.
 */
export type CredentialInvalidationScope = 'client' | 'tokens';

/**
 * Inputs shared by the stored-credential operations.
 */
export interface CredentialStoreContext {
  /** Absolute path to the mcp.json file; credentials.json lives beside it. */
  configPath: string;
  /** The downstream server the credentials entry belongs to. */
  server: DownstreamServerConfig;
  /** The discovered authorization server issuer, when known. */
  issuer?: string;
}

/**
 * Filters a raw stored entry down to the one the context may use: an
 * entry bound to a different server URL or authorization server is
 * treated as absent so it is never touched on behalf of this server.
 *
 * @param context - The server and issuer the entry must belong to.
 * @param entry - The raw on-disk entry, if any.
 * @returns The usable entry, or undefined when it does not belong here.
 */
function usableEntry(
  context: CredentialStoreContext,
  entry: StoredCredentials | undefined,
): StoredCredentials | undefined {
  return credentialsUsableFor(entry, context.server.url, context.issuer) ? entry : undefined;
}

/**
 * Builds the entry that remains after dropping the requested state,
 * preserving the cached auth-requirement probe. Returns undefined when
 * nothing credential-like or probe-related remains, so the caller can
 * remove the entry entirely.
 *
 * @param context - The server and issuer the entry belongs to.
 * @param creds - The usable entry being reduced.
 * @param drop - Which state to remove.
 * @returns The reduced entry, or undefined when it is empty.
 */
function withoutState(
  context: CredentialStoreContext,
  creds: StoredCredentials,
  drop: { clientRegistration?: boolean; tokens?: boolean },
): StoredCredentials | undefined {
  const remaining: StoredCredentials = {
    ...bindingFieldsFor(creds, context.server.url, context.issuer),
    clientRegistration: drop.clientRegistration ? undefined : creds.clientRegistration,
    tokens: drop.tokens ? undefined : creds.tokens,
    authRequirement: creds.authRequirement,
    checkedAt: creds.checkedAt,
  };
  if (
    remaining.clientRegistration === undefined &&
    remaining.tokens === undefined &&
    remaining.authRequirement === undefined
  ) {
    return undefined;
  }
  return remaining;
}

/**
 * Removes the stored OAuth tokens and client registration for the
 * server. The SDK's credential-invalidation path uses this through
 * `OAuthCredentialManager.clearTokens` and
 * `invalidateCredentials('all')`; `logout` does not. Preserves the
 * cached auth requirement so `list` still reports that the server
 * requires login. Removes the whole entry when no cached requirement
 * exists.
 *
 * @param context - The server whose credentials to clear.
 */
export async function clearStoredCredentials(context: CredentialStoreContext): Promise<void> {
  await mutateCredentials(context.configPath, context.server.name, (current) => {
    const creds = usableEntry(context, current);
    if (creds?.authRequirement) {
      return {
        authRequirement: creds.authRequirement,
        checkedAt: creds.checkedAt,
      };
    }
    return undefined;
  });
}

/**
 * Removes one kind of stored credential for the server, preserving the
 * other kind and the cached auth requirement.
 *
 * A `'tokens'` invalidation is skipped when the stored tokens are no
 * longer due for refresh: another process refreshed them while this one
 * was failing, and clearing them would discard valid credentials.
 *
 * @param context - The server whose credentials to invalidate.
 * @param scope - Which state to remove.
 */
export async function invalidateStoredCredentials(
  context: CredentialStoreContext,
  scope: CredentialInvalidationScope,
): Promise<void> {
  await mutateCredentials(context.configPath, context.server.name, (current) => {
    const creds = usableEntry(context, current);
    if (!creds) {
      return current;
    }
    if (scope === 'tokens' && !tokensNeedInvalidation(creds.tokens)) {
      return current;
    }
    return withoutState(context, creds, {
      clientRegistration: scope === 'client',
      tokens: scope === 'tokens',
    });
  });
}

/**
 * Removes the stored dynamic client registration after the authorization
 * server rejected its `client_id` with `invalid_client`, keeping the
 * stored tokens and the cached auth requirement.
 *
 * The removal is scoped to the rejected `client_id` and runs as a fresh
 * read-modify-write under the credentials lock: a registration another
 * process stored in the meantime is a replacement, not the dead one,
 * and is kept.
 *
 * @param context - The server whose registration to discard.
 * @param rejectedClientId - The `client_id` the provider rejected.
 */
export async function discardStoredClientRegistration(
  context: CredentialStoreContext,
  rejectedClientId: string,
): Promise<void> {
  await mutateCredentials(context.configPath, context.server.name, (current) => {
    const creds = usableEntry(context, current);
    const client = creds?.clientRegistration as OAuthClientInformationMixed | undefined;
    if (!creds || client?.client_id !== rejectedClientId) {
      // Another process already replaced the rejected registration;
      // clearing now would discard the replacement.
      return current;
    }
    return withoutState(context, creds, { clientRegistration: true });
  });
}
