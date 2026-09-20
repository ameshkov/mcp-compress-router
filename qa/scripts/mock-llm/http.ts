/**
 * Small HTTP helpers shared by the mock LLM's routes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Reads the full request body.
 *
 * @param req - The incoming request.
 * @returns The raw body text.
 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => resolvePromise(body));
    req.on('error', reject);
  });
}

/**
 * Writes one JSON response.
 *
 * @param res - The server response.
 * @param status - The HTTP status code.
 * @param body - The JSON body.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
