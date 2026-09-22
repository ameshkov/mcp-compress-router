/**
 * Scripted conversations for the dynamic-limit auto-degradation plans.
 *
 * Kept in a separate module so `scripts.ts` stays within the source
 * line budget; the scripts are spread into `BUILT_IN_SCRIPTS` there.
 */
import type { MockLlmScript, ScriptStep } from './scripts.js';
import { DOWNSTREAM_TOOLS, ROUTER_GET_SCHEMA } from './script-constants.js';

/** Server name the dynamic-limit scenarios add to the router. */
const SERVER = 'stdio-mock-bulk';

/** Tool count with `MOCK_EXTRA_TOOLS=200`: the standard five plus 200 bulk. */
const TOOL_COUNT = 205;

/**
 * Steps that verify a length-limited client receives the degraded
 * catalog and can still discover the hidden tools through list mode.
 *
 * The first step checks that the whole catalog collapsed to the tool
 * count (the bulk tools are no longer listed) and then asks for the
 * list; the second step proves the hidden tools come back through
 * `get_tool_schema`.
 *
 * @returns The scripted steps.
 */
function degradedSteps(): ScriptStep[] {
  return [
    {
      expect: {
        toolsContain: ['get_tool_schema', 'invoke_tool'],
        toolsAbsent: [...DOWNSTREAM_TOOLS, 'bulk_tool_001'],
        catalogIncludes: [`## ${SERVER}`, `Provides ${TOOL_COUNT} tools`],
        catalogExcludes: ['bulk_tool_001'],
      },
      respond: { tool: { name: ROUTER_GET_SCHEMA, arguments: { server: SERVER } } },
    },
    {
      expect: {
        toolCallsInclude: [{ name: 'get_tool_schema', argumentsInclude: [SERVER] }],
        messagesInclude: ['Tools provided by', 'bulk_tool_001'],
      },
      respond: { text: 'The degraded catalog still allows listing every tool.' },
    },
  ];
}

/**
 * Steps that verify a client outside the dynamic-limit list keeps the
 * configured compression level even when the catalog exceeds the cap.
 *
 * @returns The scripted steps.
 */
function keptSteps(): ScriptStep[] {
  return [
    {
      expect: {
        toolsContain: ['get_tool_schema', 'invoke_tool'],
        toolsAbsent: [...DOWNSTREAM_TOOLS, 'bulk_tool_001'],
        catalogIncludes: [`## ${SERVER}`, 'bulk_tool_001'],
        catalogExcludes: [`Provides ${TOOL_COUNT} tools`],
      },
      respond: { text: 'The full catalog reached the model without degradation.' },
    },
  ];
}

/** Scripts covering the auto-degradation behavior for both client kinds. */
export const DYNAMIC_LIMIT_SCRIPTS: MockLlmScript[] = [
  {
    name: 'dynamic-limit-degraded',
    description:
      'Verify a length-limited client gets the catalog degraded to max and list mode still works.',
    steps: degradedSteps(),
  },
  {
    name: 'dynamic-limit-kept',
    description:
      'Verify a client outside the dynamic-limit list keeps the configured catalog above the cap.',
    steps: keptSteps(),
  },
];
