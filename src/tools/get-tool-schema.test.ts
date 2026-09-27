import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  buildGetToolSchemaDescription,
  createGetToolSchemaHandler,
  GetToolSchemaInputSchema,
} from './get-tool-schema.js';
import type { ToolCatalog } from '../utils/index.js';
import { Logger } from '../utils/index.js';

/** The fixed list-mode hint (stable for tests and QA). */
const HINT =
  'Call get_tool_schema with a tool name to get its full description and parameter schema.';

/** The extracted result of a handler call (success and error paths). */
interface HandlerResult {
  text: string;
  isError?: boolean;
}

function makeCatalog(): ToolCatalog {
  const echo = {
    name: 'echo',
    description: 'Echoes the input message.',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
  };
  const add = {
    name: 'add',
    description: 'Adds two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
    },
  };
  const crash = {
    name: 'crash',
    description: 'Terminates the process.',
    inputSchema: {},
  };
  const search = {
    name: 'search',
    description: 'Searches pages.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  };

  return {
    servers: [
      {
        name: 'fixture',
        description: 'A test fixture server',
        status: 'ok',
        tools: [echo, add, crash],
      },
      {
        name: 'empty',
        description: 'An empty server',
        status: 'ok',
        tools: [],
      },
      {
        name: 'auth',
        description: 'An authenticated server',
        status: 'unauthorized',
        tools: [search],
      },
    ],
    toolMap: new Map([
      ['fixture::echo', echo],
      ['fixture::add', add],
      ['fixture::crash', crash],
      ['auth::search', search],
    ]),
    filteredToolNames: new Set(),
  };
}

async function callHandler(
  catalog: ToolCatalog,
  args: { server: string; tools?: string[] },
): Promise<HandlerResult> {
  const handler = createGetToolSchemaHandler(catalog, new Logger('error'));
  const result = (await handler(args)) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  return { text: result.content[0].text, isError: result.isError };
}

describe('createGetToolSchemaHandler — list mode', () => {
  it('lists tool signatures when tools is omitted', async () => {
    const { text, isError } = await callHandler(makeCatalog(), { server: 'fixture' });

    expect(isError).toBeUndefined();
    expect(text).toBe(
      [
        'Tools provided by "fixture" (3):',
        '',
        'echo(message)',
        'add(a, b)',
        'crash()',
        '',
        HINT,
      ].join('\n'),
    );
  });

  it('treats an empty tools array exactly like an omitted one', async () => {
    const catalog = makeCatalog();
    const omitted = await callHandler(catalog, { server: 'fixture' });
    const empty = await callHandler(catalog, { server: 'fixture', tools: [] });

    expect(empty.isError).toBeUndefined();
    expect(empty.text).toBe(omitted.text);
  });

  it('reports an unknown server with the available servers', async () => {
    const { text, isError } = await callHandler(makeCatalog(), { server: 'nope' });

    expect(isError).toBe(true);
    expect(text).toBe('Error: Server "nope" not found. Available servers: fixture, empty, auth');
  });

  it('renders the dedicated message for a zero-tool server', async () => {
    const { text, isError } = await callHandler(makeCatalog(), { server: 'empty' });

    expect(isError).toBeUndefined();
    expect(text).toBe('Server "empty" advertises no tools.');
  });

  it('includes the status line for an unauthorized server', async () => {
    const { text, isError } = await callHandler(makeCatalog(), { server: 'auth' });

    expect(isError).toBeUndefined();
    expect(text).toContain('Tools provided by "auth" (1):');
    expect(text).toContain(
      'Requires authentication. Ask the user to run: ' +
        'npx mcp-compress-router login auth. This opens a browser ' +
        'for interactive authorization. Do not run it yourself.',
    );
    expect(text).toContain('search(query)');
  });
});

describe('createGetToolSchemaHandler — explicit mode', () => {
  it('returns the JSON schema array for named tools', async () => {
    const { text, isError } = await callHandler(makeCatalog(), {
      server: 'fixture',
      tools: ['echo'],
    });

    expect(isError).toBeUndefined();
    expect(JSON.parse(text)).toEqual([
      {
        name: 'echo',
        description: 'Echoes the input message.',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
      },
    ]);
  });

  it('reports an unknown tool with the valid tool names', async () => {
    const { text, isError } = await callHandler(makeCatalog(), {
      server: 'fixture',
      tools: ['ghost'],
    });

    expect(isError).toBe(true);
    expect(text).toContain('Tool(s) not found on server "fixture": ghost.');
    expect(text).toContain('Valid tools: echo, add, crash');
  });
});

describe('GetToolSchemaInputSchema', () => {
  const schema = z.object(GetToolSchemaInputSchema);

  it('accepts a server without tools', () => {
    expect(schema.safeParse({ server: 'fixture' }).success).toBe(true);
  });

  it('accepts an empty tools array', () => {
    expect(schema.safeParse({ server: 'fixture', tools: [] }).success).toBe(true);
  });

  it('rejects a missing server', () => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('accepts 50 tool names and rejects 51', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `tool_${i}`);
    expect(schema.safeParse({ server: 'fixture', tools: fifty }).success).toBe(true);
    expect(schema.safeParse({ server: 'fixture', tools: [...fifty, 'tool_50'] }).success).toBe(
      false,
    );
  });
});

/** The fixed intro paragraph of the get_tool_schema description. */
const INTRO =
  'Get the JSON schema for one or more tools from a connected MCP server, ' +
  "or omit the tool names to list a server's tools and their arguments. " +
  'You MUST call this for a tool before you can invoke it with invoke_tool.';

/** The footer of a catalog whose first advertised server is `fixture`. */
const CATALOG_FOOTER =
  'Call get_tool_schema with the server name to list all tools, i.e. get_tool_schema(fixture)';

describe('buildGetToolSchemaDescription', () => {
  it('joins the intro, the server bullets, and the footer with blank lines', () => {
    const description = buildGetToolSchemaDescription(makeCatalog());

    expect(description).toBe(
      `${INTRO}\n\n` +
        '- fixture (3 tools) - A test fixture server\n' +
        '- auth (1 tool) - An authenticated server\n' +
        '  Requires authentication. Ask the user to run: npx mcp-compress-router login auth. ' +
        'This opens a browser for interactive authorization. Do not run it yourself.\n\n' +
        CATALOG_FOOTER,
    );
  });

  it('never leaks tool names or signatures into the description', () => {
    const description = buildGetToolSchemaDescription(makeCatalog());

    expect(description).not.toContain('echo');
    expect(description).not.toContain('echo(message)');
    expect(description).not.toContain('Available tools:');
  });

  it('omits zero-tool servers from the catalog', () => {
    const description = buildGetToolSchemaDescription(makeCatalog());

    expect(description).not.toContain('empty');
    expect(description).not.toContain('An empty server');
  });

  it('returns the intro alone when no server advertises tools', () => {
    const catalog: ToolCatalog = {
      servers: [{ name: 'empty', description: 'An empty server', status: 'ok', tools: [] }],
      toolMap: new Map(),
      filteredToolNames: new Set(),
    };

    expect(buildGetToolSchemaDescription(catalog)).toBe(INTRO);
  });
});
