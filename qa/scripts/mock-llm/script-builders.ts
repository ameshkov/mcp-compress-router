/**
 * Step builders for the scripted conversations served by the QA mock
 * LLM.
 *
 * Kept separate from `scripts.ts` (which owns the script types and the
 * built-in registry) so both files stay within the source line budget.
 * The builders import the script types type-only, so there is no
 * runtime cycle with `scripts.ts`.
 */
import { LONG_DESCRIPTION_HEAD, LONG_DESCRIPTION_TAIL } from '../mock-long-description.js';
import {
  CLAUDE_TRUNCATION_MARKER,
  DOWNSTREAM_TOOLS,
  ROUTER_GET_SCHEMA,
  ROUTER_INVOKE,
} from './script-constants.js';
import type { ScriptStep } from './scripts.js';

/**
 * Builds the steps that verify the tool surface, the compact catalog,
 * and the list-mode signatures.
 *
 * The catalog renders only the server section and the tool count — no
 * tool names — so the second step asks for the list and proves the
 * signatures and the hint reached the model.
 *
 * @param server - The configured downstream server name.
 * @param toolCount - How many tools the server advertises.
 * @param signatures - The expected list-mode signatures.
 * @param downstreamTools - The server's downstream tool names, which
 *   must not be advertised directly or leak into the catalog. Defaults
 *   to the standard stdio set; the HTTP/OAuth mocks pass their extra
 *   `whoami`.
 * @returns The scripted steps.
 */
export function catalogSteps(
  server: string,
  toolCount: number,
  signatures: string[],
  downstreamTools: string[] = DOWNSTREAM_TOOLS,
): ScriptStep[] {
  return [
    {
      expect: {
        toolsContain: ['get_tool_schema', 'invoke_tool'],
        toolsAbsent: downstreamTools,
        catalogIncludes: [
          `- ${server} (${toolCount} tools)`,
          'Call get_tool_schema with the server name to list all tools',
        ],
        catalogExcludes: downstreamTools,
      },
      respond: { tool: { name: ROUTER_GET_SCHEMA, arguments: { server } } },
    },
    {
      expect: {
        toolCallsInclude: [{ name: 'get_tool_schema', argumentsInclude: [server] }],
        messagesInclude: [
          'Tools provided by',
          ...signatures,
          'Call get_tool_schema with a tool name',
        ],
      },
      respond: { text: `The ${server} catalog and tool list reached the model.` },
    },
  ];
}

/**
 * Builds the full schema + invoke round trip for one downstream server.
 *
 * The scripted model reads the `add` schema, invokes it for 20 + 22,
 * and only finishes after the result "42" is back in the conversation.
 *
 * @param server - The configured downstream server name.
 * @param downstreamTools - The server's downstream tool names, which
 *   must not be advertised directly. Defaults to the standard stdio
 *   set; the HTTP/OAuth mocks pass their extra `whoami`.
 * @returns The scripted steps.
 */
export function roundTripSteps(
  server: string,
  downstreamTools: string[] = DOWNSTREAM_TOOLS,
): ScriptStep[] {
  return [
    {
      expect: {
        toolsContain: ['get_tool_schema', 'invoke_tool'],
        toolsAbsent: downstreamTools,
        catalogIncludes: [`- ${server} (`],
      },
      respond: { tool: { name: ROUTER_GET_SCHEMA, arguments: { server, tools: ['add'] } } },
    },
    {
      expect: {
        toolCallsInclude: [{ name: 'get_tool_schema', argumentsInclude: [server, 'add'] }],
        messagesInclude: ['inputSchema'],
      },
      respond: {
        tool: {
          name: ROUTER_INVOKE,
          arguments: { server, tool: 'add', arguments: { a: 20, b: 22 } },
        },
      },
    },
    {
      expect: {
        toolCallsInclude: [{ name: 'invoke_tool', argumentsInclude: [server, 'add', '20', '22'] }],
        messagesInclude: ['42'],
      },
      respond: { text: `The ${server} add tool returned 42.` },
    },
  ];
}

/**
 * Builds the list-mode steps for one downstream server.
 *
 * The scripted model calls `get_tool_schema` without tool names and the
 * second step proves the signature list and the hint reached the model
 * through the message history.
 *
 * @param server - The configured downstream server name.
 * @returns The scripted steps.
 */
export function toolListSteps(server: string): ScriptStep[] {
  return [
    {
      expect: {
        toolsContain: ['get_tool_schema', 'invoke_tool'],
        toolsAbsent: DOWNSTREAM_TOOLS,
        catalogIncludes: [`- ${server} (6 tools)`],
      },
      respond: { tool: { name: ROUTER_GET_SCHEMA, arguments: { server } } },
    },
    {
      expect: {
        toolCallsInclude: [{ name: 'get_tool_schema', argumentsInclude: [server] }],
        messagesInclude: [
          'Tools provided by',
          'echo(message)',
          'add(a, b)',
          'Call get_tool_schema with a tool name',
        ],
      },
      respond: { text: `The ${server} tool list reached the model.` },
    },
  ];
}

/** Steps that recover from the router's invalid-argument error. */
export const RETRY_STEPS: ScriptStep[] = [
  {
    expect: {
      toolsContain: ['invoke_tool'],
      catalogIncludes: ['- stdio-mock (6 tools)'],
    },
    respond: {
      tool: {
        name: ROUTER_INVOKE,
        arguments: { server: 'stdio-mock', tool: 'add', arguments: { a: 30 } },
      },
    },
  },
  {
    expect: {
      toolCallsInclude: [{ name: 'invoke_tool', argumentsInclude: ['stdio-mock', '30'] }],
      messagesInclude: ['Missing required argument'],
    },
    respond: {
      tool: {
        name: ROUTER_INVOKE,
        arguments: { server: 'stdio-mock', tool: 'add', arguments: { a: 30, b: 12 } },
      },
    },
  },
  {
    expect: {
      toolCallsInclude: [{ name: 'invoke_tool', argumentsInclude: ['30', '12'] }],
      messagesInclude: ['42'],
    },
    respond: { text: 'The retry returned 42.' },
  },
];

/** Steps that verify a downstream error result reaches the agent. */
export const FAIL_STEPS: ScriptStep[] = [
  {
    expect: {
      toolsContain: ['invoke_tool'],
      catalogIncludes: ['- stdio-mock (6 tools)'],
    },
    respond: {
      tool: {
        name: ROUTER_INVOKE,
        arguments: { server: 'stdio-mock', tool: 'failing_tool', arguments: { message: 'boom' } },
      },
    },
  },
  {
    expect: {
      toolCallsInclude: [{ name: 'invoke_tool', argumentsInclude: ['failing_tool', 'boom'] }],
      messagesInclude: ['boom'],
    },
    respond: { text: 'The failing tool reported "boom".' },
  },
];

/**
 * Steps that verify every downstream tool description reaches the model.
 *
 * The catalog never carries tool descriptions, so the scripted model
 * asks for the schemas of the standard tools in one call and the second
 * step proves the complete descriptions came back in the result.
 *
 * @returns The scripted steps.
 */
export function descriptionSteps(): ScriptStep[] {
  return [
    {
      expect: {
        toolsContain: ['get_tool_schema', 'invoke_tool'],
        toolsAbsent: DOWNSTREAM_TOOLS,
        catalogIncludes: ['- stdio-mock (6 tools)'],
        catalogExcludes: DOWNSTREAM_TOOLS,
      },
      respond: {
        tool: {
          name: ROUTER_GET_SCHEMA,
          arguments: {
            server: 'stdio-mock',
            tools: ['echo', 'add', 'multi_block', 'failing_tool'],
          },
        },
      },
    },
    {
      expect: {
        toolCallsInclude: [
          { name: 'get_tool_schema', argumentsInclude: ['stdio-mock', 'echo', 'add'] },
        ],
        messagesInclude: [
          'Returns the input message with an',
          'Adds two numbers together',
          'Returns multiple content blocks of different types',
          'Returns an error result with a specific message',
        ],
      },
      respond: { text: 'Every tool description reached the model through the schema result.' },
    },
  ];
}

/**
 * Steps that verify the catalog stays compact while a long tool
 * description reaches the model through the result path.
 *
 * The catalog renders only the server section and the tool count, so
 * neither the head nor the tail marker appears in it; the second step
 * proves the `get_tool_schema` result carries the complete description.
 *
 * @param server - The configured downstream server name.
 * @returns The scripted steps.
 */
export function longDescriptionSteps(server: string): ScriptStep[] {
  return [
    {
      expect: {
        toolsContain: ['get_tool_schema', 'invoke_tool'],
        toolsAbsent: DOWNSTREAM_TOOLS,
        catalogIncludes: [`- ${server} (6 tools)`],
        catalogExcludes: [LONG_DESCRIPTION_HEAD, LONG_DESCRIPTION_TAIL],
      },
      respond: {
        tool: { name: ROUTER_GET_SCHEMA, arguments: { server, tools: ['documented_tool'] } },
      },
    },
    {
      expect: {
        toolCallsInclude: [
          { name: 'get_tool_schema', argumentsInclude: [server, 'documented_tool'] },
        ],
        messagesInclude: [LONG_DESCRIPTION_HEAD, LONG_DESCRIPTION_TAIL],
      },
      respond: { text: 'The complete long description reached the model.' },
    },
  ];
}

/**
 * Steps that verify Claude Code truncates an over-long catalog.
 *
 * A server added with a long `--description` makes the catalog exceed
 * Claude Code's 2048-character tool-description cap: the head and the
 * `… [truncated]` marker reach the model, the tail does not. The router
 * never truncates a server description itself, so the plan pairs this
 * script with a probe run that shows the complete text in the router's
 * own catalog.
 *
 * @param server - The configured downstream server name.
 * @returns The scripted steps.
 */
export function truncatedCatalogSteps(server: string): ScriptStep[] {
  return [
    {
      expect: {
        toolsContain: ['get_tool_schema', 'invoke_tool'],
        toolsAbsent: DOWNSTREAM_TOOLS,
        catalogIncludes: [`- ${server} (`, LONG_DESCRIPTION_HEAD, CLAUDE_TRUNCATION_MARKER],
        catalogExcludes: [LONG_DESCRIPTION_TAIL],
      },
      respond: { text: 'Claude Code truncated the over-long catalog.' },
    },
  ];
}
