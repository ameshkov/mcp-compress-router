import { describe, it, expect } from 'vitest';
import { renderCompactCatalog } from './text-format.js';
import type { CatalogServer } from './types.js';

/** Builds a minimal healthy server with the given tools. */
function makeServer(overrides: Partial<CatalogServer> = {}): CatalogServer {
  return {
    name: 'srv',
    description: 'A test server',
    status: 'ok',
    tools: [
      { name: 'tool1', inputSchema: { type: 'object' } },
      { name: 'tool2', inputSchema: { type: 'object' } },
    ],
    ...overrides,
  };
}

/** The footer for a catalog whose first advertised server is `srv`. */
const SRV_FOOTER =
  'Call get_tool_schema with the server name to list all tools, i.e. get_tool_schema(srv)';

describe('renderCompactCatalog', () => {
  it('renders one bullet per server with its tool count instead of tool names', () => {
    const text = renderCompactCatalog([
      makeServer({
        tools: [
          { name: 'tool1', inputSchema: { type: 'object' } },
          { name: 'tool2', inputSchema: { type: 'object' } },
          { name: 'tool3', inputSchema: { type: 'object' } },
        ],
      }),
    ]);

    expect(text).toBe(`- srv (3 tools) - A test server\n\n${SRV_FOOTER}`);
    expect(text).not.toContain('Available tools:');
    expect(text).not.toContain('tool1');
  });

  it('uses singular wording for a single tool', () => {
    const text = renderCompactCatalog([
      makeServer({ tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }),
    ]);

    expect(text).toBe(`- srv (1 tool) - A test server\n\n${SRV_FOOTER}`);
  });

  it('omits a zero-tool server from the catalog entirely', () => {
    const text = renderCompactCatalog([makeServer({ name: 'empty', tools: [] })]);

    expect(text).toBe('');
    expect(text).not.toContain('empty');
    expect(text).not.toContain('Available tools:');
  });

  it('omits a degraded zero-tool server from the catalog too', () => {
    const text = renderCompactCatalog([
      makeServer({ name: 'empty', status: 'unavailable', tools: [] }),
    ]);

    expect(text).toBe('');
  });

  it('omits the description separator when the server has no description', () => {
    const text = renderCompactCatalog([makeServer({ description: undefined })]);

    expect(text).toBe(`- srv (2 tools)\n\n${SRV_FOOTER}`);
  });

  it('separates servers with single newlines and names the first advertised server in the footer', () => {
    const text = renderCompactCatalog([
      makeServer({ name: 'alpha', description: 'Alpha server' }),
      makeServer({ name: 'beta', tools: [] }),
      makeServer({
        name: 'gamma',
        tools: [{ name: 'ping', inputSchema: { type: 'object' } }],
      }),
    ]);

    expect(text).toBe(
      '- alpha (2 tools) - Alpha server\n' +
        '- gamma (1 tool) - A test server\n\n' +
        'Call get_tool_schema with the server name to list all tools, ' +
        'i.e. get_tool_schema(alpha)',
    );
  });

  it('returns an empty string for an empty catalog', () => {
    expect(renderCompactCatalog([])).toBe('');
  });

  it('never renders tool names, signatures, or descriptions', () => {
    const text = renderCompactCatalog([
      makeServer({
        tools: [
          {
            name: 'fetch',
            description: 'Fetches a URL.',
            inputSchema: {
              type: 'object',
              properties: { url: { type: 'string' } },
            },
          },
        ],
      }),
    ]);

    expect(text).not.toContain('fetch');
    expect(text).not.toContain('Fetches a URL');
    expect(text).not.toContain('url');
  });

  it('keeps a long server description in the catalog', () => {
    const description = 'HEAD ' + 'x'.repeat(4096) + ' TAIL';
    const text = renderCompactCatalog([makeServer({ description })]);

    expect(text).toContain('HEAD');
    expect(text).toContain('TAIL');
  });

  it('renders an indented status line under an unauthorized server bullet', () => {
    const text = renderCompactCatalog([makeServer({ name: 'figma', status: 'unauthorized' })]);

    expect(text).toContain('- figma (2 tools) - A test server');
    expect(text).toContain(
      '\n  Requires authentication. Ask the user to run: npx mcp-compress-router login figma.',
    );
    expect(text).toContain('This opens a browser for interactive authorization');
    expect(text).toContain('Do not run it yourself');
  });

  it('renders an indented status line under an unavailable server bullet', () => {
    const text = renderCompactCatalog([makeServer({ name: 'my-api', status: 'unavailable' })]);

    expect(text).toContain('- my-api (2 tools) - A test server');
    expect(text).toContain('\n  Server unavailable. Check connectivity and configuration.');
  });

  it('does not render a status line for an ok server', () => {
    const text = renderCompactCatalog([makeServer({ name: 'fixture' })]);

    expect(text).toContain('- fixture (2 tools)');
    expect(text).not.toContain('Requires authentication');
    expect(text).not.toContain('unavailable');
  });
});
