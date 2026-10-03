/**
 * HTML pages served by the temporary loopback OAuth callback server.
 *
 * The pages are self-contained — inline CSS and inline SVG, no external
 * requests — and carry the `mcp-compress-router` name, so the browser
 * window that opens during `login` is identifiable as this tool. Every
 * interpolated value is HTML-escaped, so OAuth error text reflected
 * from the callback query cannot inject markup.
 */

/** Visual variant of a callback page. */
type CallbackPageKind = 'success' | 'error';

/** Inputs for {@link renderCallbackPage}. */
export interface CallbackPageOptions {
  /** Visual variant: success (green check) or error (red cross). */
  kind: CallbackPageKind;
  /** Page `<title>` and card heading. */
  heading: string;
  /** Main message shown below the heading. */
  message: string;
  /**
   * Optional raw detail (for example the OAuth error code), rendered as
   * a monospace chip below the message. Omit for no detail line.
   */
  detail?: string;
}

/**
 * Styles shared by every callback page. A single constant keeps the
 * pages self-contained (no external stylesheet) and defines the layout
 * once for both variants; the error variant only swaps the accent
 * colors.
 */
const PAGE_STYLES = `      :root {
        color-scheme: light dark;
        --bg: #f4f5f7;
        --card-bg: #ffffff;
        --card-border: #e3e5e8;
        --text: #1b1f24;
        --muted: #656d76;
        --code-bg: #f0f1f3;
        --accent: #1a7f37;
        --accent-soft: #dafbe1;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0d1117;
          --card-bg: #161b22;
          --card-border: #30363d;
          --text: #e6edf3;
          --muted: #8b949e;
          --code-bg: #21262d;
          --accent: #3fb950;
          --accent-soft: #12261e;
        }
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: var(--bg);
        color: var(--text);
        font-family:
          -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial,
          sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      .card {
        width: 100%;
        max-width: 420px;
        padding: 40px 32px 28px;
        background: var(--card-bg);
        border: 1px solid var(--card-border);
        border-radius: 14px;
        box-shadow: 0 8px 24px rgb(0 0 0 / 8%);
        text-align: center;
      }
      .card.error {
        --accent: #cf222e;
        --accent-soft: #ffebe9;
      }
      @media (prefers-color-scheme: dark) {
        .card.error {
          --accent: #f85149;
          --accent-soft: #2d1416;
        }
      }
      .icon {
        display: block;
        width: 56px;
        height: 56px;
        margin: 0 auto 20px;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 20px;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      p {
        margin: 0;
        font-size: 14px;
        line-height: 1.5;
        color: var(--muted);
      }
      p + p {
        margin-top: 12px;
      }
      .detail code {
        display: inline-block;
        padding: 3px 8px;
        font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
        font-size: 13px;
        color: var(--text);
        background: var(--code-bg);
        border-radius: 6px;
      }
      footer {
        margin-top: 28px;
        padding-top: 16px;
        border-top: 1px solid var(--card-border);
        font-size: 12px;
        color: var(--muted);
      }`;

/**
 * Renders one self-contained callback page.
 *
 * @param options - Page content and variant.
 * @returns A complete HTML document.
 */
export function renderCallbackPage(options: CallbackPageOptions): string {
  const title = `${escapeHtml(options.heading)} — mcp-compress-router`;
  const detail = options.detail
    ? `\n      <p class="detail"><code>${escapeHtml(options.detail)}</code></p>`
    : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
${PAGE_STYLES}
    </style>
  </head>
  <body>
    <main class="card ${options.kind}">
      ${statusIcon(options.kind)}
      <h1>${escapeHtml(options.heading)}</h1>
      <p>${escapeHtml(options.message)}</p>${detail}
      <footer>mcp-compress-router</footer>
    </main>
  </body>
</html>
`;
}

/**
 * Builds the inline SVG status icon for a page variant.
 *
 * @param kind - Page variant.
 * @returns The SVG markup (static, contains no user input).
 */
function statusIcon(kind: CallbackPageKind): string {
  const path =
    kind === 'success'
      ? '<path d="M19 29l7 7 12-14" fill="none" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />'
      : '<path d="M21 21l14 14M35 21L21 35" fill="none" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" />';
  return `<svg class="icon" viewBox="0 0 56 56" aria-hidden="true" focusable="false">
        <circle cx="28" cy="28" r="28" fill="var(--accent-soft)" />
        ${path}
      </svg>`;
}

/**
 * Escapes the HTML special characters in a reflected value, so an OAuth
 * error string cannot inject markup into a callback page.
 *
 * @param value - The raw value to escape.
 * @returns The escaped value.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
