/**
 * Deliberately long description shared by the QA mock MCP servers, the
 * mock LLM expectations, and the Claude Code truncation plan.
 *
 * The description starts with `LONG_DESCRIPTION_HEAD` and ends with
 * `LONG_DESCRIPTION_TAIL`. The compact catalog only carries the first
 * sentence of a description, so the plans check the head marker in the
 * catalog and the tail marker in the `get_tool_schema` result the agent
 * forwards to the model. `pnpm --silent qa:long-description` prints the
 * same text for use as a server's `--description`, which grows the
 * catalog past Claude Code's tool-description cap in the truncation
 * plan. The `documented_tool` in `mock-mcp-tools.ts` uses this text as
 * its description, and the mock LLM scripts assert on the markers.
 */

/** Marker at the start of the long tool description. */
export const LONG_DESCRIPTION_HEAD = 'LONG-DESCRIPTION-HEAD';

/** Marker at the end of the long tool description. */
export const LONG_DESCRIPTION_TAIL = 'LONG-DESCRIPTION-TAIL';

/**
 * The paragraphs of the long description, joined with blank lines.
 *
 * Every paragraph is plain prose on purpose: a realistic server
 * description, not a repeated filler string, so the catalog stays
 * readable in the mock LLM log.
 */
const PARAGRAPHS = [
  `${LONG_DESCRIPTION_HEAD} The documented tool exists to exercise ` +
    'description passthrough in the manual QA plans. Real MCP servers ship ' +
    'descriptions that are far longer than a single sentence: they list every ' +
    'argument, explain defaults, warn about side effects, and point at related ' +
    'tools. At the low compression level the router embeds only the first ' +
    'sentence of those descriptions in the compact catalog and returns the ' +
    'complete text in the get_tool_schema result, so both paths have to ' +
    'survive the coding agent request pipeline unchanged.',

  'Use the documented tool whenever a scenario needs a description that is ' +
    'longer than the truncation cap of the coding agent under test. The tool ' +
    'itself does nothing surprising: it takes a single input string and returns ' +
    'that string with a "documented: " prefix, mirroring the echo tool. The ' +
    'value is in the description, not in the behavior, which keeps the expected ' +
    'result easy to recognize in the mock LLM log.',

  'The first argument, input, is a plain string. The tool does not interpret ' +
    'it, normalize it, or validate it beyond the schema the router already ' +
    'enforces. If the input contains newlines or quotes, they are preserved ' +
    'verbatim in the result, so a tester can use the tool to confirm that ' +
    'special characters survive the whole router round trip. An empty string is ' +
    'valid and returns the prefix with nothing after it.',

  'The tool has no side effects. It does not read files, contact the network, ' +
    'or write state anywhere, so it is safe to invoke in any order and any ' +
    'number of times. Scenarios use it after the schema has already been read ' +
    'through get_tool_schema, which is also what the mock LLM scripts do: the ' +
    'first turn reads the schema and the second turn verifies that the complete ' +
    'description reached the model in the tool result.',

  'Descriptions of this length are common in real deployments. Servers that ' +
    'wrap issue trackers, cloud APIs, or database explorers often document ' +
    'pagination, filtering, authentication scopes, rate limits, and error ' +
    'semantics in the tool description, because the JSON schema alone cannot ' +
    'express all of it. A router that silently truncated those descriptions ' +
    'would hide exactly the guidance a model needs before calling the tool.',

  'This paragraph exists purely to push the description past the two thousand ' +
    'character mark, which is where several coding agents start cutting tool ' +
    'descriptions before sending them to the model. If the model can read this ' +
    'sentence, the agent under test passed the description through without a ' +
    'cap at one kilobyte, two kilobytes, or any other intermediate limit the ' +
    'plans do not know about in advance.',

  'The catalog path and the schema path are both covered. At the low ' +
    'compression level the router renders only the first sentence of the ' +
    'description inside the get_tool_schema tool description, so the ' +
    'catalogIncludes check verifies the head marker there and the ' +
    'catalogExcludes check verifies the tail marker is absent. The ' +
    'get_tool_schema call then returns the complete text inside the JSON ' +
    'result, and the messagesInclude check verifies the tail marker in the ' +
    'next request the agent sends, proving the tool result was not cut.',

  'When a plan fails on this tool, the mock LLM log shows which side dropped ' +
    'the text: a failed catalogIncludes check names the marker missing from ' +
    'the tool description, while a failed messagesInclude check names the ' +
    'marker missing from the tool result history. Inspect the raw log with ' +
    '"pnpm qa:llm log --raw" to see the exact text the agent sent. The ' +
    `description ends here: ${LONG_DESCRIPTION_TAIL}.`,
];

/**
 * A tool description that is deliberately longer than typical coding-agent
 * truncation caps (about 2.5 KB).
 */
export const LONG_DESCRIPTION = PARAGRAPHS.join('\n\n');
