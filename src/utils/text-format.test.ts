import { describe, it, expect } from 'vitest';
import { renderCompactCatalog } from './text-format.js';
import type { CatalogServer } from './types.js';

describe('renderCompactCatalog', () => {
  it('renders only the tools present on the (already-filtered) server', () => {
    const servers: CatalogServer[] = [
      {
        name: 'github',
        description: 'GitHub server',
        compressionLevel: 'high',
        tools: [
          {
            name: 'list_issues',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toContain('## github');
    expect(text).toContain('GitHub server');
    expect(text).toContain('Available tools:');
    expect(text).toContain('list_issues()');
    expect(text).not.toContain('delete_repo');
  });

  it('renders a server with zero tools as just a header', () => {
    const servers: CatalogServer[] = [
      {
        name: 'staged',
        compressionLevel: 'high',
        tools: [],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toContain('## staged');
    expect(text).not.toContain('Available tools:');
    expect(text.trim()).toBe('## staged');
  });

  it('separates servers with blank lines and renders one tool per line', () => {
    const servers: CatalogServer[] = [
      {
        name: 'alpha',
        description: 'Alpha server',
        compressionLevel: 'high',
        tools: [{ name: 'a1', inputSchema: { type: 'object' } }],
      },
      {
        name: 'beta',
        compressionLevel: 'high',
        tools: [{ name: 'b1', inputSchema: { type: 'object' } }],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toBe(
      '## alpha\nAlpha server\n\nAvailable tools:\na1()\n\n## beta\n\nAvailable tools:\nb1()',
    );
  });

  it('renders tool name with argument names in schema order at high level', () => {
    const servers: CatalogServer[] = [
      {
        name: 'srv',
        compressionLevel: 'high',
        tools: [
          {
            name: 'fetch',
            inputSchema: {
              type: 'object',
              properties: { url: { type: 'string' }, timeout: { type: 'number' } },
            },
          },
        ],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toContain('fetch(url, timeout)');
  });

  it('renders a zero-parameter tool as name()', () => {
    const servers: CatalogServer[] = [
      {
        name: 'srv',
        compressionLevel: 'high',
        tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toContain('ping()');
  });

  it('renders multiple tools each on a separate line under Available tools', () => {
    const servers: CatalogServer[] = [
      {
        name: 'srv',
        compressionLevel: 'high',
        tools: [
          {
            name: 'first',
            inputSchema: {
              type: 'object',
              properties: { a: { type: 'string' } },
            },
          },
          {
            name: 'second',
            inputSchema: {
              type: 'object',
              properties: { b: { type: 'number' }, c: { type: 'string' } },
            },
          },
        ],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toBe('## srv\n\nAvailable tools:\nfirst(a)\nsecond(b, c)');
  });
});
