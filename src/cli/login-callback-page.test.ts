import { describe, it, expect } from 'vitest';
import { renderCallbackPage } from './login-callback-page.js';

describe('renderCallbackPage', () => {
  it('renders a branded success page', () => {
    const html = renderCallbackPage({
      kind: 'success',
      heading: 'Authorization successful',
      message: 'You can close this window and return to your terminal.',
    });

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>Authorization successful — mcp-compress-router</title>');
    expect(html).toContain('<h1>Authorization successful</h1>');
    expect(html).toContain('You can close this window and return to your terminal.');
    expect(html).toContain('<main class="card success">');
    expect(html).toContain('<footer>mcp-compress-router</footer>');
    // The success variant shows the check mark path.
    expect(html).toContain('M19 29l7 7 12-14');
  });

  it('renders a branded error page with the error code as detail', () => {
    const html = renderCallbackPage({
      kind: 'error',
      heading: 'Authorization failed',
      message: 'The authorization server rejected the request.',
      detail: 'invalid_target',
    });

    expect(html).toContain('<main class="card error">');
    expect(html).toContain('<h1>Authorization failed</h1>');
    expect(html).toContain('<code>invalid_target</code>');
    expect(html).toContain('<footer>mcp-compress-router</footer>');
    // The error variant shows the cross path.
    expect(html).toContain('M21 21l14 14M35 21L21 35');
  });

  it('omits the detail chip when no detail is given', () => {
    const html = renderCallbackPage({
      kind: 'error',
      heading: 'Authorization failed',
      message: 'Invalid OAuth callback.',
    });

    expect(html).not.toContain('<code>');
  });

  it('escapes heading, message, and detail', () => {
    const html = renderCallbackPage({
      kind: 'error',
      heading: '<h1>bad</h1>',
      message: '<script>alert(1)</script>',
      detail: '"><img src=x onerror=alert(1)>',
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });
});
