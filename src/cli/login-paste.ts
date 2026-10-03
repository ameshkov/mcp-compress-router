import * as readline from 'node:readline';

/**
 * Reader for manually pasted authorization responses.
 */
export interface PasteReader {
  /**
   * Reads one line of pasted input.
   *
   * @param message - Prompt shown before reading.
   * @returns The entered line, or undefined when the input stream ends.
   */
  readLine(message: string): Promise<string | undefined>;

  /** Releases the underlying stdin reader. */
  close(): void;
}

/**
 * Parsed form of a pasted authorization response.
 */
type ParsedPaste =
  | { kind: 'url'; code: string; url: URL }
  | { kind: 'code'; code: string }
  | { kind: 'error'; error: string; description: string | null; url: URL }
  | { kind: 'invalid'; reason: string };

/** Prompt shown while waiting for a pasted authorization response. */
const PASTE_PROMPT = 'Paste the full redirect URL (or the authorization code): ';

/** Suffix appended to parsing and validation feedback messages. */
const RETRY_HINT = ' Try again, or press Ctrl-D to cancel.';

/**
 * Parses a pasted authorization response: either the full redirect URL
 * from the browser's address bar (validated by the caller against the
 * login's `state`/`iss`) or a bare authorization code.
 *
 * @internal Exported for tests only; not part of the public module API.
 * @param input - The pasted text.
 * @returns The parsed response.
 */
export function parsePastedAuthorizationInput(input: string): ParsedPaste {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { kind: 'invalid', reason: 'Nothing was pasted.' };
  }

  const url = tryParseUrl(trimmed);
  if (url) {
    const error = url.searchParams.get('error');
    if (error !== null) {
      return {
        kind: 'error',
        error,
        description: url.searchParams.get('error_description'),
        url,
      };
    }
    const code = url.searchParams.get('code');
    if (code === null || code.length === 0) {
      return { kind: 'invalid', reason: 'The pasted URL has no "code" parameter.' };
    }
    return { kind: 'url', code, url };
  }

  if (/\s/.test(trimmed)) {
    return {
      kind: 'invalid',
      reason: 'That does not look like a redirect URL or an authorization code.',
    };
  }
  return { kind: 'code', code: trimmed };
}

/**
 * Parses pasted text as an absolute URL, tolerating a missing scheme when
 * the text carries an authorization-response parameter (a copy from a
 * terminal browser may drop it).
 *
 * @param input - The trimmed pasted text.
 * @returns The parsed URL, or undefined when the text is not a URL.
 */
function tryParseUrl(input: string): URL | undefined {
  try {
    return new URL(input);
  } catch {
    if (!input.includes('code=') && !input.includes('error=')) {
      return undefined;
    }
  }
  try {
    return new URL(`http://${input}`);
  } catch {
    return undefined;
  }
}

/**
 * Creates the interactive stdin reader used for pasted authorization
 * responses.
 *
 * @returns The reader, or undefined when stdin is not a TTY (for example
 *   in CI), where the login keeps waiting for the loopback callback.
 */
export function createPasteReader(): PasteReader | undefined {
  if (!process.stdin.isTTY) {
    return undefined;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let pending: ((value: string | undefined) => void) | undefined;
  let closed = false;
  rl.on('close', () => {
    closed = true;
    pending?.(undefined);
    pending = undefined;
  });
  rl.on('SIGINT', () => {
    // Treat Ctrl-C like Ctrl-D: close the reader so the pending readLine
    // resolves with undefined and the login cancels cleanly.
    rl.close();
  });
  return {
    readLine(message) {
      if (closed) {
        return Promise.resolve(undefined);
      }
      return new Promise((resolve) => {
        pending = resolve;
        rl.question(message, (answer) => {
          pending = undefined;
          resolve(answer);
        });
      });
    },
    close() {
      rl.close();
    },
  };
}

/** Inputs for {@link startManualCodeWait}. */
interface ManualWaitOptions {
  /** Reader supplying pasted authorization responses. */
  reader: Pick<PasteReader, 'readLine'>;
  /** Validates a pasted redirect URL; returns an error message or undefined. */
  validate: (url: URL) => string | undefined;
  /** Prints parsing and validation feedback. */
  print: (message: string) => void;
  /** Settles the login with the accepted authorization code. */
  settle: (code: string) => void;
  /** Fails the login. */
  fail: (err: Error) => void;
}

/**
 * Reads pasted authorization responses until one is accepted, then
 * settles the login through the provided callbacks. Invalid or
 * mismatched input is reported and re-prompted; end-of-input cancels.
 *
 * @param options - Reader, validation, output, and settlement callbacks.
 */
export function startManualCodeWait(options: ManualWaitOptions): void {
  void runManualCodeWait(options).catch(options.fail);
}

/**
 * Runs the paste prompt loop.
 *
 * @param options - Reader, validation, output, and settlement callbacks.
 * @returns A promise that resolves once the flow is settled.
 */
async function runManualCodeWait(options: ManualWaitOptions): Promise<void> {
  for (;;) {
    const input = await options.reader.readLine(PASTE_PROMPT);
    if (input === undefined) {
      options.fail(
        new Error('OAuth login was cancelled before an authorization code was provided.'),
      );
      return;
    }

    const parsed = parsePastedAuthorizationInput(input);
    if (parsed.kind === 'invalid') {
      options.print(`${parsed.reason}${RETRY_HINT}`);
      continue;
    }
    if (parsed.kind === 'error' || parsed.kind === 'url') {
      const validationError = options.validate(parsed.url);
      if (validationError) {
        options.print(`${validationError}${RETRY_HINT}`);
        continue;
      }
      if (parsed.kind === 'error') {
        const detail = parsed.description ? ` (${parsed.description})` : '';
        options.fail(new Error(`Authorization failed: ${parsed.error}${detail}`));
        return;
      }
      options.settle(parsed.code);
      return;
    }
    options.settle(parsed.code);
    return;
  }
}
