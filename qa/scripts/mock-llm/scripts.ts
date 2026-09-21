/**
 * Scripted conversations served by the QA mock LLM.
 *
 * Each step is one assistant turn plus the expectations the mock
 * verifies against the incoming model request. Tool turns are answered
 * by the coding agent with the real router result before the next step
 * is served, so one script exercises the whole agent -> router ->
 * downstream round trip without a real model.
 *
 * The expectations are the heart of the manual tests: they check that
 * the agent advertised exactly the router's tools (not the downstream
 * ones), that the `get_tool_schema` description carries the expected
 * catalog section, and that the agent sent the scripted tool calls with
 * the expected arguments.
 */

import { LONG_DESCRIPTION_HEAD, LONG_DESCRIPTION_TAIL } from '../mock-long-description.js';

/** One tool call the scripted model returns to the coding agent. */
export interface ScriptedToolCall {
  /** Wire name of the tool, e.g. `qa-router_get_tool_schema`. */
  name: string;
  /** JSON arguments for the tool call. */
  arguments: Record<string, unknown>;
  /**
   * Namespace the resolved tool lives in. Scripts never set this; the
   * mock adds it while resolving the call against the agent's advertised
   * tools so the Responses adapter can render a dispatchable call.
   */
  namespace?: string;
}

/** One expected tool call in the conversation the agent sends back. */
export interface ExpectedToolCall {
  /**
   * Tool name; matched exactly or by `_`-separated suffix so plans do
   * not depend on the host's MCP server key (e.g. `get_tool_schema`
   * matches `qa-router_get_tool_schema`).
   */
  name: string;
  /** Substrings that must appear in the compact JSON of the arguments. */
  argumentsInclude?: string[];
}

/** Expectations evaluated against one incoming model request. */
export interface StepExpectation {
  /** Tool names that must be present in the request's tool list. */
  toolsContain?: string[];
  /** Tool names that must NOT be present (downstream tools must not leak). */
  toolsAbsent?: string[];
  /** Substrings that must appear in the `get_tool_schema` description. */
  catalogIncludes?: string[];
  /** Substrings that must NOT appear in the `get_tool_schema` description. */
  catalogExcludes?: string[];
  /** Substrings that must appear in the message history (results, errors). */
  messagesInclude?: string[];
  /** Tool calls that must appear in the message history. */
  toolCallsInclude?: ExpectedToolCall[];
}

/** One scripted assistant turn with optional request expectations. */
export interface ScriptStep {
  /** Checks the mock runs before serving this step. */
  expect?: StepExpectation;
  /** Assistant turn to serve: a tool call or a final text. */
  respond: { tool: ScriptedToolCall } | { text: string };
}

/** A named scripted conversation. */
export interface MockLlmScript {
  /** Script name used by `pnpm qa:llm script <name>`. */
  name: string;
  /** One-line summary shown by `pnpm qa:llm list`. */
  description: string;
  /** Assistant turns served in order. */
  steps: ScriptStep[];
}

/** Wire names of the router tools as opencode prefixes them. */
const ROUTER_GET_SCHEMA = 'qa-router_get_tool_schema';
const ROUTER_INVOKE = 'qa-router_invoke_tool';

/** Downstream tool names that must never be advertised directly. */
const DOWNSTREAM_TOOLS = ['echo', 'add', 'multi_block', 'failing_tool', 'documented_tool'];

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

/**
 * Builds the steps that only verify the tool surface and catalog.
 *
 * @param server - The configured downstream server name.
 * @param extraToolLines - Additional catalog lines to verify (e.g.
 *   `whoami` for the HTTP mocks).
 * @returns The scripted steps.
 */
function catalogSteps(server: string, extraToolLines: string[] = []): ScriptStep[] {
  return [
    {
      expect: {
        toolsContain: ['get_tool_schema', 'invoke_tool'],
        toolsAbsent: DOWNSTREAM_TOOLS,
        catalogIncludes: [
          `## ${server}`,
          'echo',
          'add',
          'multi_block',
          'failing_tool',
          'documented_tool',
          ...extraToolLines,
        ],
      },
      respond: { text: `The ${server} catalog is registered with the router.` },
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
 * @returns The scripted steps.
 */
function roundTripSteps(server: string): ScriptStep[] {
  return [
    {
      expect: {
        toolsContain: ['get_tool_schema', 'invoke_tool'],
        toolsAbsent: DOWNSTREAM_TOOLS,
        catalogIncludes: [`## ${server}`, 'add'],
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
function toolListSteps(server: string): ScriptStep[] {
  return [
    {
      expect: {
        toolsContain: ['get_tool_schema', 'invoke_tool'],
        toolsAbsent: DOWNSTREAM_TOOLS,
        catalogIncludes: [`## ${server}`, 'echo'],
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
const RETRY_STEPS: ScriptStep[] = [
  {
    expect: {
      toolsContain: ['invoke_tool'],
      catalogIncludes: ['## stdio-mock'],
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
const FAIL_STEPS: ScriptStep[] = [
  {
    expect: {
      toolsContain: ['invoke_tool'],
      catalogIncludes: ['## stdio-mock'],
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
 * At the low compression level the catalog renders each tool as its
 * signature plus the first sentence of its description, so the scenario
 * adds the stdio mock with `--compression-level low`. The mock tools
 * except `documented_tool` have single-sentence descriptions, so their
 * first sentence is the complete description.
 *
 * @returns The scripted steps.
 */
function descriptionSteps(): ScriptStep[] {
  return [
    {
      expect: {
        toolsContain: ['get_tool_schema', 'invoke_tool'],
        toolsAbsent: DOWNSTREAM_TOOLS,
        catalogIncludes: [
          'echo(message): Returns the input message with an "echo: " prefix',
          'add(a, b): Adds two numbers together',
          'multi_block(prefix): Returns multiple content blocks of different types',
          'failing_tool(message): Returns an error result with a specific message',
        ],
      },
      respond: { text: 'Every tool description is visible in the catalog.' },
    },
  ];
}

/**
 * Steps that verify a long tool description reaches the model through
 * the result path while the catalog carries only its first sentence.
 *
 * At the low compression level the catalog renders the first sentence
 * of `documented_tool`, which still contains the head marker but never
 * the tail; the second step proves the `get_tool_schema` result carries
 * the complete description through as well.
 *
 * @param server - The configured downstream server name.
 * @returns The scripted steps.
 */
function longDescriptionSteps(server: string): ScriptStep[] {
  return [
    {
      expect: {
        toolsContain: ['get_tool_schema', 'invoke_tool'],
        toolsAbsent: DOWNSTREAM_TOOLS,
        catalogIncludes: ['documented_tool(input)', LONG_DESCRIPTION_HEAD],
        catalogExcludes: [LONG_DESCRIPTION_TAIL],
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
        messagesInclude: [LONG_DESCRIPTION_TAIL],
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
function truncatedCatalogSteps(server: string): ScriptStep[] {
  return [
    {
      expect: {
        toolsContain: ['get_tool_schema', 'invoke_tool'],
        toolsAbsent: DOWNSTREAM_TOOLS,
        catalogIncludes: [`## ${server}`, LONG_DESCRIPTION_HEAD, CLAUDE_TRUNCATION_MARKER],
        catalogExcludes: [LONG_DESCRIPTION_TAIL],
      },
      respond: { text: 'Claude Code truncated the over-long catalog.' },
    },
  ];
}

/** The built-in scripts a tester can select. */
const BUILT_IN_SCRIPTS: MockLlmScript[] = [
  {
    name: 'stdio-catalog',
    description: 'Verify the stdio mock catalog and the two router tools.',
    steps: catalogSteps('stdio-mock'),
  },
  {
    name: 'stdio-roundtrip',
    description: 'Read the stdio mock add schema, invoke 20 + 22, expect 42.',
    steps: roundTripSteps('stdio-mock'),
  },
  {
    name: 'tool-list',
    description: "List the stdio mock's tools without schemas and verify the signatures return.",
    steps: toolListSteps('stdio-mock'),
  },
  {
    name: 'http-catalog',
    description: 'Verify the streamable-http mock catalog and the two router tools.',
    steps: catalogSteps('http-mock', ['whoami']),
  },
  {
    name: 'http-roundtrip',
    description: 'Read the streamable-http mock add schema, invoke 20 + 22, expect 42.',
    steps: roundTripSteps('http-mock'),
  },
  {
    name: 'oauth-catalog',
    description: 'Verify the OAuth-protected mock catalog and the two router tools.',
    steps: catalogSteps('oauth-mock', ['whoami']),
  },
  {
    name: 'oauth-roundtrip',
    description: 'Read the OAuth-protected mock add schema, invoke 20 + 22, expect 42.',
    steps: roundTripSteps('oauth-mock'),
  },
  {
    name: 'retry',
    description: 'Invoke add with a missing argument, then recover with the fixed call.',
    steps: RETRY_STEPS,
  },
  {
    name: 'fail',
    description: 'Invoke failing_tool and verify the downstream error reaches the agent.',
    steps: FAIL_STEPS,
  },
  {
    name: 'stdio-descriptions',
    description:
      'Verify every stdio tool description reaches the model as a first sentence (low compression).',
    steps: descriptionSteps(),
  },
  {
    name: 'long-description',
    description:
      'Verify the catalog carries the documented_tool first sentence and the result the full text.',
    steps: longDescriptionSteps('stdio-mock'),
  },
  {
    name: 'long-catalog-truncated',
    description:
      'Verify Claude Code truncates the over-long catalog description and drops the tail.',
    steps: truncatedCatalogSteps('stdio-mock-long'),
  },
];

/**
 * Returns one built-in script by name.
 *
 * @param name - The script name.
 * @returns The script, or undefined when the name is unknown.
 */
export function getScript(name: string): MockLlmScript | undefined {
  return BUILT_IN_SCRIPTS.find((script) => script.name === name);
}

/**
 * Lists the built-in scripts for the admin API and `pnpm qa:llm list`.
 *
 * @returns A summary per built-in script.
 */
export function listScripts(): Array<{ name: string; description: string; steps: number }> {
  return BUILT_IN_SCRIPTS.map((script) => ({
    name: script.name,
    description: script.description,
    steps: script.steps.length,
  }));
}

/**
 * Returns the names of the built-in scripts.
 *
 * @returns The script names in listing order.
 */
export function scriptNames(): string[] {
  return BUILT_IN_SCRIPTS.map((script) => script.name);
}
