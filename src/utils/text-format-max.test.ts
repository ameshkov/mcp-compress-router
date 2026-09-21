import { describe, it, expect } from 'vitest';
import { renderCompactCatalog } from './text-format.js';
import type { CatalogServer } from './types.js';

describe('renderCompactCatalog — max level', () => {
  it('renders the tool count and a get_tool_schema pointer instead of names', () => {
    const servers: CatalogServer[] = [
      {
        name: 'srv',
        compressionLevel: 'max',
        status: 'ok',
        tools: [
          { name: 'tool1', inputSchema: { type: 'object' } },
          { name: 'tool2', inputSchema: { type: 'object' } },
          { name: 'tool3', inputSchema: { type: 'object' } },
        ],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toBe('## srv\n\nProvides 3 tools. Call get_tool_schema with "srv" to list them.');
    expect(text).not.toContain('Available tools:');
    expect(text).not.toContain('tool1');
  });

  it('renders the description and status line before the count', () => {
    const servers: CatalogServer[] = [
      {
        name: 'auth',
        description: 'Auth server',
        compressionLevel: 'max',
        status: 'unauthorized',
        tools: [
          { name: 'a', inputSchema: { type: 'object' } },
          { name: 'b', inputSchema: { type: 'object' } },
        ],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toBe(
      '## auth\nAuth server\n' +
        'Requires authentication. Run: npx mcp-compress-router login auth\n\n' +
        'Provides 2 tools. Call get_tool_schema with "auth" to list them.',
    );
  });

  it('uses singular wording for a single tool', () => {
    const servers: CatalogServer[] = [
      {
        name: 'srv',
        compressionLevel: 'max',
        status: 'ok',
        tools: [{ name: 'ping', inputSchema: { type: 'object' } }],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toBe('## srv\n\nProvides 1 tool. Call get_tool_schema with "srv" to list it.');
  });

  it('renders no listing at all for a zero-tool server', () => {
    const servers: CatalogServer[] = [
      { name: 'empty', compressionLevel: 'max', status: 'ok', tools: [] },
    ];

    const text = renderCompactCatalog(servers);

    expect(text.trim()).toBe('## empty');
    expect(text).not.toContain('Provides');
    expect(text).not.toContain('Available tools:');
  });
});
