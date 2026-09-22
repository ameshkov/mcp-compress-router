/**
 * Constants shared by the mock LLM script modules.
 *
 * Kept separate from `scripts.ts` so `scripts-dynamic-limit.ts` can
 * import them without a module-init cycle: `scripts.ts` imports the
 * dynamic-limit scripts and spreads them into its script list at load
 * time, so it cannot provide values to them.
 */

/** Wire names of the router tools as opencode prefixes them. */
export const ROUTER_GET_SCHEMA = 'qa-router_get_tool_schema';
export const ROUTER_INVOKE = 'qa-router_invoke_tool';

/** Downstream tool names that must never be advertised directly. */
export const DOWNSTREAM_TOOLS = ['echo', 'add', 'multi_block', 'failing_tool', 'documented_tool'];
