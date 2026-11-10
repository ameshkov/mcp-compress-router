import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';

/**
 * Generates one opaque mock token.
 *
 * @param prefix - A readable prefix (`client`, `code`, `at`, `rt`).
 * @returns The token string.
 */
export function randomToken(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString('hex')}`;
}

/**
 * Writes one JSON response.
 *
 * @param res - The server response.
 * @param status - The HTTP status code.
 * @param body - The JSON body.
 * @param headers - Additional response headers.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
