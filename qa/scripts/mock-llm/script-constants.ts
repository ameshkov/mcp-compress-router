/**
 * Constants shared by the mock LLM script modules.
 *
 * Kept separate from `scripts.ts` so the script builders can import them
 * without a module-init cycle.
 */

/** Wire names of the router tools as opencode prefixes them. */
export const ROUTER_GET_SCHEMA = 'qa-router_get_tool_schema';
export const ROUTER_INVOKE = 'qa-router_invoke_tool';

/**
 * Signatures of the five standard mock tools, in registration order.
 * The catalog never renders them; they arrive through list mode.
 */
export const STDIO_TOOL_SIGNATURES = [
  'echo(message)',
  'add(a, b)',
  'multi_block(prefix)',
  'failing_tool(message)',
  'documented_tool(input)',
];

/** The HTTP and OAuth mocks add `whoami()` to the standard five. */
export const HTTP_TOOL_SIGNATURES = [...STDIO_TOOL_SIGNATURES, 'whoami()'];

/**
 * Strips the argument list from a list-mode signature, so a catalog
 * check can assert on the bare tool name (`whoami`, not `whoami()`).
 *
 * @param signature - A list-mode signature such as `add(a, b)`.
 * @returns The bare tool name.
 */
function signatureToolName(signature: string): string {
  const paren = signature.indexOf('(');
  return paren === -1 ? signature : signature.slice(0, paren);
}

/** Downstream tool names that must never be advertised directly. */
export const DOWNSTREAM_TOOLS = STDIO_TOOL_SIGNATURES.map(signatureToolName);

/**
 * Downstream tool names of the HTTP and OAuth mocks: the standard five
 * plus `whoami`, derived from {@link HTTP_TOOL_SIGNATURES} so the names
 * and the signatures cannot drift apart.
 */
export const HTTP_DOWNSTREAM_TOOLS = HTTP_TOOL_SIGNATURES.map(signatureToolName);

/**
 * Suffix Claude Code appends to a tool description it truncates.
 *
 * Claude Code cuts every tool description at 2048 characters and adds
 * this marker, so an over-long catalog reaches the model as the first
 * 2048 characters plus this 13-character suffix (2061 characters
 * total). The router never emits the marker itself, which makes it the
 * evidence that the agent, not the router, dropped the text.
 */
export const CLAUDE_TRUNCATION_MARKER = '… [truncated]';
