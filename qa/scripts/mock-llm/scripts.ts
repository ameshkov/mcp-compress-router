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
 * compact catalog, and that the agent sent the scripted tool calls with
 * the expected arguments. The step builders live in `script-builders.ts`.
 */

import {
  catalogSteps,
  descriptionSteps,
  FAIL_STEPS,
  longDescriptionSteps,
  RETRY_STEPS,
  roundTripSteps,
  toolListSteps,
  truncatedCatalogSteps,
} from './script-builders.js';
import {
  HTTP_DOWNSTREAM_TOOLS,
  HTTP_TOOL_SIGNATURES,
  STDIO_TOOL_SIGNATURES,
} from './script-constants.js';

export { CLAUDE_TRUNCATION_MARKER } from './script-constants.js';

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

/** The built-in scripts a tester can select. */
const BUILT_IN_SCRIPTS: MockLlmScript[] = [
  {
    name: 'stdio-catalog',
    description: 'Verify the stdio mock catalog and the two router tools, then list its tools.',
    steps: catalogSteps('stdio-mock', 5, STDIO_TOOL_SIGNATURES),
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
    description:
      'Verify the streamable-http mock catalog and the two router tools, then list its tools.',
    steps: catalogSteps('http-mock', 6, HTTP_TOOL_SIGNATURES, HTTP_DOWNSTREAM_TOOLS),
  },
  {
    name: 'http-roundtrip',
    description: 'Read the streamable-http mock add schema, invoke 20 + 22, expect 42.',
    steps: roundTripSteps('http-mock', HTTP_DOWNSTREAM_TOOLS),
  },
  {
    name: 'oauth-catalog',
    description:
      'Verify the OAuth-protected mock catalog and the two router tools, then list its tools.',
    steps: catalogSteps('oauth-mock', 6, HTTP_TOOL_SIGNATURES, HTTP_DOWNSTREAM_TOOLS),
  },
  {
    name: 'oauth-roundtrip',
    description: 'Read the OAuth-protected mock add schema, invoke 20 + 22, expect 42.',
    steps: roundTripSteps('oauth-mock', HTTP_DOWNSTREAM_TOOLS),
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
    description: 'Verify every stdio tool description reaches the model through the schema result.',
    steps: descriptionSteps(),
  },
  {
    name: 'long-description',
    description:
      'Verify the catalog stays compact and the schema result carries the complete long description.',
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
