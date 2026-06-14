/**
 * Headless browser stand-in for OAuth E2E tests.
 *
 * Spawned by `openBrowser` when `MCP_COMPRESS_ROUTER_BROWSER` points here.
 * It "opens" the OAuth authorization URL by following its redirects
 * end-to-end, which delivers the authorization code back to the login
 * command's local callback server — exactly what a real browser would do.
 *
 * Usage: `node browser-mock.js <authorize-url>`
 *
 * @param argv[2] - The authorization URL to "open".
 */
const url = process.argv[2];

if (url) {
  const controller = new AbortController();
  // Ensure the process exits even if the callback closes mid-response.
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(url, { redirect: 'follow', signal: controller.signal });
  } catch {
    // The callback server may close before the response is read; ignore.
  } finally {
    clearTimeout(timeout);
  }
}
