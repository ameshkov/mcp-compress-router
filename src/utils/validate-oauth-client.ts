/**
 * Validation helpers for OAuth client metadata overrides
 * (`oauth.clientName` and `oauth.clientUri`).
 *
 * The values are sent as the RFC 7591 `client_name` and `client_uri`
 * fields of a dynamic client registration request. Providers that
 * allowlist client identities (e.g. Figma) gate registration on these
 * fields, so a server entry can present a different client than the
 * router default. Both the Config Loader and the `add` / `login` CLI
 * commands validate through these helpers so the rules stay consistent.
 */

/**
 * Validates and normalizes an OAuth client name (`client_name`).
 *
 * Leading and trailing whitespace is trimmed; an empty or
 * whitespace-only name is rejected so a registration cannot go out
 * with a blank identity.
 *
 * @param value - Raw client name.
 * @param field - Human-readable field name for error messages
 *   (e.g. `oauth.clientName` or `--client-name`).
 * @returns The trimmed client name.
 * @throws If the trimmed value is empty.
 */
export function validateOAuthClientName(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return trimmed;
}

/**
 * Validates an OAuth client URI (`client_uri`).
 *
 * Leading and trailing whitespace is trimmed before validation, and the
 * trimmed value is what gets sent to the registration endpoint: a padded
 * value would otherwise be compared verbatim against the stored
 * registration on every login. The value must parse as an absolute
 * `http` or `https` URL; RFC 7591 defines `client_uri` as the URL of the
 * client's home page.
 *
 * @param value - Raw client URI.
 * @param field - Human-readable field name for error messages
 *   (e.g. `oauth.clientUri` or `--client-uri`).
 * @returns The trimmed client URI.
 * @throws If the value is not an absolute http(s) URL.
 */
export function validateOAuthClientUri(value: string, field: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${field} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${field} must be an absolute http(s) URL`);
  }
  return trimmed;
}
