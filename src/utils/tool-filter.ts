import picomatch from 'picomatch';
import type { ToolDescriptor } from './types.js';

/**
 * Per-tool exposure decision computed by {@link filterTools}.
 *
 * - `'exposed'` — the tool survives filtering and is available to the LLM.
 * - `'filtered'` — the tool is hidden from the catalog and blocked at
 *   invoke time.
 *
 * @public
 */
export type ToolExposureDecision = 'exposed' | 'filtered';

/**
 * A single tool paired with its exposure decision, produced by
 * {@link filterTools}. One entry exists per input tool, in input order.
 *
 * @public
 */
export interface ToolExposureEntry {
  /** The original tool descriptor. */
  descriptor: ToolDescriptor;
  /** Whether this tool is exposed or filtered. */
  decision: ToolExposureDecision;
}

/**
 * Result of {@link filterTools}.
 *
 * @public
 */
export interface ToolFilterResult {
  /** Tools that survive filtering, in input order. */
  exposed: ToolDescriptor[];
  /** One entry per input tool, in input order, with its decision. */
  entries: ToolExposureEntry[];
  /** Configured patterns that matched no real tool name (allowlist then denylist order). */
  unmatchedPatterns: string[];
}

/**
 * Compiles picomatch patterns into boolean matchers.
 *
 * Uses the same `strictBrackets: true` option as the Config Loader's
 * validation step so matching semantics are identical to validation.
 *
 * @param patterns - Glob patterns to compile.
 * @returns An array of matchers, or `undefined` when `patterns` is undefined
 *   (signals "no allowlist/denylist configured").
 */
function compileMatchers(
  patterns: string[] | undefined,
): ((input: string) => boolean)[] | undefined {
  if (patterns === undefined) return undefined;
  return patterns.map((p) => picomatch(p, { strictBrackets: true }));
}

/**
 * Returns the patterns from `patterns` that matched no name in `names`.
 *
 * @param patterns - Configured patterns (literals or globs). Undefined → no patterns.
 * @param names - Real tool names discovered from the server.
 * @returns Patterns that matched zero names, in input order.
 */
function findUnmatched(patterns: string[] | undefined, names: string[]): string[] {
  if (patterns === undefined) return [];
  const matchers = compileMatchers(patterns)!;
  const unmatched: string[] = [];
  patterns.forEach((pattern, i) => {
    const matcher = matchers[i];
    if (!names.some((n) => matcher(n))) {
      unmatched.push(pattern);
    }
  });
  return unmatched;
}

/**
 * Computes the effective exposed tool set for one downstream server.
 *
 * Semantics (per PRD §"Implementation Decisions"):
 *
 * - **No allowlist** (`allowedTools === undefined`) → every tool starts as
 *   a candidate.
 * - **Allowlist present** (including `[]`) → only tools matching at least
 *   one allowlist pattern are candidates. `[]` means no tools.
 * - **Denylist present** → removes matching candidates. Wins on conflict:
 *   a tool matching both lists is filtered.
 * - Patterns match bare tool names only (full-string picomatch match).
 *
 * This function is pure, performs no I/O, and never throws — invalid
 * patterns were already rejected by the Config Loader.
 *
 * @param tools - Tool descriptors discovered from the server.
 * @param allowedTools - Optional allowlist glob patterns.
 * @param disabledTools - Optional denylist glob patterns.
 * @returns The exposed set, per-tool decisions, and unmatched patterns.
 * @public
 */
export function filterTools(
  tools: ToolDescriptor[],
  allowedTools?: string[],
  disabledTools?: string[],
): ToolFilterResult {
  const allowMatchers = compileMatchers(allowedTools);
  const denyMatchers = compileMatchers(disabledTools);

  const entries: ToolExposureEntry[] = [];
  const exposed: ToolDescriptor[] = [];

  for (const descriptor of tools) {
    const name = descriptor.name;
    const isCandidate = allowMatchers === undefined || allowMatchers.some((m) => m(name));
    const isDenied = denyMatchers !== undefined && denyMatchers.some((m) => m(name));
    const isExposed = isCandidate && !isDenied;
    entries.push({
      descriptor,
      decision: isExposed ? 'exposed' : 'filtered',
    });
    if (isExposed) {
      exposed.push(descriptor);
    }
  }

  const names = tools.map((t) => t.name);
  const unmatchedPatterns = [
    ...findUnmatched(allowedTools, names),
    ...findUnmatched(disabledTools, names),
  ];

  return {
    exposed,
    entries,
    unmatchedPatterns,
  };
}
