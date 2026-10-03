import { describe, it, expect, vi } from 'vitest';
import { parsePastedAuthorizationInput, startManualCodeWait } from './login-paste.js';

describe('parsePastedAuthorizationInput', () => {
  it('parses a full redirect URL and keeps it for state validation', () => {
    const parsed = parsePastedAuthorizationInput(
      'http://127.0.0.1:54321/mcp-compress-router/oauth-callback?code=abc&state=xyz',
    );
    expect(parsed).toMatchObject({ kind: 'url', code: 'abc' });
    if (parsed.kind !== 'url') throw new Error('expected a URL result');
    expect(parsed.url.searchParams.get('state')).toBe('xyz');
  });

  it('tolerates a redirect URL pasted without its scheme', () => {
    const parsed = parsePastedAuthorizationInput(
      '127.0.0.1:54321/mcp-compress-router/oauth-callback?code=abc&state=xyz',
    );
    expect(parsed).toMatchObject({ kind: 'url', code: 'abc' });
  });

  it('parses an error redirect URL with its description', () => {
    const parsed = parsePastedAuthorizationInput(
      'http://127.0.0.1:1/cb?error=access_denied&error_description=Nope&state=xyz',
    );
    expect(parsed).toMatchObject({
      kind: 'error',
      error: 'access_denied',
      description: 'Nope',
    });
  });

  it('rejects a URL without an authorization response', () => {
    expect(parsePastedAuthorizationInput('https://example.com/help')).toEqual({
      kind: 'invalid',
      reason: 'The pasted URL has no "code" parameter.',
    });
  });

  it('treats a bare code as an authorization code', () => {
    expect(parsePastedAuthorizationInput('  abc-123  ')).toEqual({ kind: 'code', code: 'abc-123' });
  });

  it('rejects empty and prose input', () => {
    expect(parsePastedAuthorizationInput('   ')).toMatchObject({ kind: 'invalid' });
    expect(parsePastedAuthorizationInput('I could not find the URL')).toMatchObject({
      kind: 'invalid',
    });
  });
});

/** Starts a manual wait with scripted input and captures its callbacks. */
function startWait(options: {
  inputs: Array<string | undefined>;
  validate?: (url: URL) => string | undefined;
}) {
  const readLine = vi.fn(async () => options.inputs.shift());
  const print = vi.fn();
  const settle = vi.fn();
  const fail = vi.fn();
  startManualCodeWait({
    reader: { readLine },
    validate: options.validate ?? (() => undefined),
    print,
    settle,
    fail,
  });
  return { readLine, print, settle, fail };
}

describe('startManualCodeWait', () => {
  it('settles with the code from a validated redirect URL', async () => {
    const wait = startWait({
      inputs: ['http://127.0.0.1:1/cb?code=abc&state=xyz'],
      validate: () => undefined,
    });

    await vi.waitFor(() => expect(wait.settle).toHaveBeenCalledWith('abc'));
    expect(wait.fail).not.toHaveBeenCalled();
    expect(wait.readLine).toHaveBeenCalledTimes(1);
  });

  it('settles with a bare code without URL validation', async () => {
    const validate = vi.fn(() => undefined);
    const wait = startWait({ inputs: ['bare-code'], validate });

    await vi.waitFor(() => expect(wait.settle).toHaveBeenCalledWith('bare-code'));
    expect(validate).not.toHaveBeenCalled();
  });

  it('re-prompts after invalid input and a rejected state', async () => {
    const wait = startWait({
      inputs: [
        'not a code at all',
        'http://127.0.0.1:1/cb?code=stale&state=wrong',
        'http://127.0.0.1:1/cb?code=fresh&state=good',
      ],
      validate: (url) => (url.searchParams.get('state') === 'good' ? undefined : 'state mismatch'),
    });

    await vi.waitFor(() => expect(wait.settle).toHaveBeenCalledWith('fresh'));
    expect(wait.readLine).toHaveBeenCalledTimes(3);
    expect(wait.print).toHaveBeenCalledWith(expect.stringContaining('Try again'));
    expect(wait.print).toHaveBeenCalledWith(expect.stringContaining('state mismatch'));
    expect(wait.fail).not.toHaveBeenCalled();
  });

  it('fails with the authorization error from a matching error URL', async () => {
    const wait = startWait({
      inputs: ['http://127.0.0.1:1/cb?error=access_denied&error_description=Nope&state=xyz'],
      validate: () => undefined,
    });

    await vi.waitFor(() => expect(wait.fail).toHaveBeenCalled());
    const error = wait.fail.mock.calls[0]![0] as Error;
    expect(error.message).toMatch(/Authorization failed: access_denied \(Nope\)/);
    expect(wait.settle).not.toHaveBeenCalled();
  });

  it('re-prompts when an error URL does not match the login state', async () => {
    const wait = startWait({
      inputs: [
        'http://127.0.0.1:1/cb?error=access_denied&state=wrong',
        'http://127.0.0.1:1/cb?code=good&state=good',
      ],
      validate: (url) => (url.searchParams.get('state') === 'good' ? undefined : 'state mismatch'),
    });

    await vi.waitFor(() => expect(wait.settle).toHaveBeenCalledWith('good'));
    expect(wait.fail).not.toHaveBeenCalled();
  });

  it('cancels when the reader reports end-of-input', async () => {
    const wait = startWait({ inputs: [undefined] });

    await vi.waitFor(() => expect(wait.fail).toHaveBeenCalled());
    const error = wait.fail.mock.calls[0]![0] as Error;
    expect(error.message).toMatch(/cancelled/);
  });
});
