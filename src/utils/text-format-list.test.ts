import { describe, it, expect } from 'vitest';
import { renderToolListResponse, renderToolSignature } from './text-format.js';
import type { CatalogServer, ToolDescriptor } from './types.js';

/** The fixed list-mode hint (stable for tests and QA). */
const HINT =
  'Call get_tool_schema with a tool name to get its full description and parameter schema.';

function makeServer(overrides: Partial<CatalogServer> = {}): CatalogServer {
  return {
    name: 'fixture',
    compressionLevel: 'high',
    status: 'ok',
    tools: [
      {
        name: 'echo',
        description: 'Echoes the input message.',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
      },
      {
        name: 'add',
        description: 'Adds two numbers.',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
        },
      },
      {
        name: 'crash',
        description: 'Terminates the server.',
        inputSchema: {},
      },
    ],
    ...overrides,
  };
}

describe('renderToolSignature', () => {
  it('renders a zero-argument tool as name()', () => {
    const tool: ToolDescriptor = { name: 'crash', inputSchema: {} };
    expect(renderToolSignature(tool)).toBe('crash()');
  });

  it('preserves property definition order', () => {
    const tool: ToolDescriptor = {
      name: 'add',
      inputSchema: { type: 'object', properties: { b: {}, a: {} } },
    };
    expect(renderToolSignature(tool)).toBe('add(b, a)');
  });

  it('renders name() when properties are absent', () => {
    const tool: ToolDescriptor = { name: 'ping', inputSchema: { type: 'object' } };
    expect(renderToolSignature(tool)).toBe('ping()');
  });
});

describe('renderToolListResponse', () => {
  it('renders the exact header, signatures, and hint', () => {
    const text = renderToolListResponse(makeServer());
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

  it('does not leak tool descriptions into the list', () => {
    const text = renderToolListResponse(makeServer());
    expect(text).not.toContain('Echoes the input message.');
    expect(text).not.toContain('Adds two numbers.');
    expect(text).not.toContain('Terminates the server.');
  });

  it('ignores the compression level and always renders signatures', () => {
    const text = renderToolListResponse(makeServer({ compressionLevel: 'max' }));
    expect(text).toContain('echo(message)');
    expect(text).toContain('add(a, b)');
  });

  it('places the authentication status line under the header', () => {
    const text = renderToolListResponse(makeServer({ status: 'unauthorized' }));
    expect(text).toBe(
      [
        'Tools provided by "fixture" (3):',
        'Requires authentication. Ask the user to run: ' +
          'npx mcp-compress-router login fixture. This opens a browser ' +
          'for interactive authorization. Do not run it yourself.',
        '',
        'echo(message)',
        'add(a, b)',
        'crash()',
        '',
        HINT,
      ].join('\n'),
    );
  });

  it('includes the connectivity status line for unavailable servers', () => {
    const text = renderToolListResponse(makeServer({ status: 'unavailable' }));
    expect(text).toContain('Server unavailable. Check connectivity and configuration.');
  });

  it('renders a dedicated message for a zero-tool server', () => {
    const text = renderToolListResponse(makeServer({ name: 'empty', tools: [] }));
    expect(text).toBe('Server "empty" advertises no tools.');
  });

  it('appends the status line to the zero-tool message', () => {
    const text = renderToolListResponse(
      makeServer({ name: 'empty', tools: [], status: 'unauthorized' }),
    );
    expect(text).toBe(
      'Server "empty" advertises no tools.\n' +
        'Requires authentication. Ask the user to run: ' +
        'npx mcp-compress-router login empty. This opens a browser ' +
        'for interactive authorization. Do not run it yourself.',
    );
  });
});
