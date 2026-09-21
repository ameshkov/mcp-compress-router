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
        compressionLevel: 'high',
        status: 'ok',
        tools: [echo, add, crash],
      },
      {
        name: 'empty',
        compressionLevel: 'high',
        status: 'ok',
        tools: [],
      },
      {
        name: 'auth',
        compressionLevel: 'high',
        status: 'unauthorized',
        tools: [search],
      },
      {
        name: 'maxed',
        compressionLevel: 'max',
        status: 'ok',
        tools: [echo, add],
      },
    ],
    toolMap: new Map([
      ['fixture::echo', echo],
      ['fixture::add', add],
      ['fixture::crash', crash],
      ['auth::search', search],
      ['maxed::echo', echo],
      ['maxed::add', add],
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
    expect(text).toBe(
      'Error: Server "nope" not found. Available servers: fixture, empty, auth, maxed',
    );
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

  it('ignores the compression level and always renders signatures', async () => {
    const { text } = await callHandler(makeCatalog(), { server: 'maxed' });

    expect(text).toContain('echo(message)');
    expect(text).toContain('add(a, b)');
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

describe('buildGetToolSchemaDescription', () => {
  it('explains the list mode and embeds the compact catalog', () => {
    const description = buildGetToolSchemaDescription(makeCatalog());

    expect(description).toContain(
      "or omit the tool names to list a server's tools and their arguments",
    );
    expect(description).toContain('You MUST call this for a tool before you can invoke it');
    expect(description).toContain('## fixture');
    expect(description).toContain('echo, add, crash');
    expect(description).not.toContain('echo(message)');
  });

  it('renders a max-level server as a tool count and a get_tool_schema pointer', () => {
    const description = buildGetToolSchemaDescription(makeCatalog());

    expect(description).toContain(
      '## maxed\n\nProvides 2 tools. Call get_tool_schema with "maxed" to list them.',
    );

    const maxedSection = description.slice(description.indexOf('## maxed'));
    expect(maxedSection).not.toContain('echo');
    expect(maxedSection).not.toContain('Available tools:');
  });
});
