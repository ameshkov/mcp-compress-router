/**
 * Raw request/response log for the QA mock LLM.
 *
 * Every request the mock serves is appended as one entry carrying the
 * complete request body, the expectation check results, and the complete
 * response body. The log is the primary evidence of the manual tests:
 * `pnpm qa:llm log` renders it, `pnpm qa:llm log --raw` prints it as
 * JSON, and the same entries are written to the container's stdout, so
 * `docker compose logs mock-llm` shows the raw traffic as well.
 */
import type { CheckResult } from './checks.js';

/** The kind of assistant turn the mock served. */
export type ResponseKind =
  'text' | 'tool' | 'auxiliary' | 'exhausted' | 'no-script' | 'validation-error';

/** One logged request/response pair. */
export interface LlmLogEntry {
  /** 1-based sequence number across all requests. */
  index: number;
  /** ISO timestamp of the request. */
  timestamp: string;
  /** True for tool-less requests such as title generation. */
  auxiliary: boolean;
  /** Script step served, or null when no step was involved. */
  stepIndex: number | null;
  /** The complete request body. */
  request: unknown;
  /** Expectation check results for this request. */
  checks: CheckResult[];
  /** The complete response body and how it was served. */
  response: {
    kind: ResponseKind;
    body: unknown;
    streamed: boolean;
  };
}

/** In-memory log with stable sequence numbers. */
export class LlmRequestLog {
  private readonly entries: LlmLogEntry[] = [];

  /**
   * Appends one request/response pair.
   *
   * @param entry - The entry without its sequence number and timestamp.
   * @returns The stored entry.
   */
  add(entry: Omit<LlmLogEntry, 'index' | 'timestamp'>): LlmLogEntry {
    const stored: LlmLogEntry = {
      index: this.entries.length + 1,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.entries.push(stored);
    return stored;
  }

  /**
   * Returns every stored entry in request order.
   *
   * @returns A copy of the entry list.
   */
  list(): LlmLogEntry[] {
    return [...this.entries];
  }

  /**
   * Removes every stored entry.
   */
  clear(): void {
    this.entries.length = 0;
  }

  /**
   * Returns the number of stored entries.
   *
   * @returns The entry count.
   */
  get size(): number {
    return this.entries.length;
  }
}
