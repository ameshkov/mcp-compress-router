import { describe, it, expect } from 'vitest';
import { renderCompactCatalog } from './text-format.js';
import type { CatalogServer } from './types.js';

describe('renderCompactCatalog', () => {
  it('renders only the tools present on the (already-filtered) server', () => {
    const servers: CatalogServer[] = [
      {
        name: 'github',
        description: 'GitHub server',
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
    expect(text).toContain('list_issues');
    expect(text).not.toContain('delete_repo');
  });

  it('renders a server with zero tools as just a header', () => {
    const servers: CatalogServer[] = [
      {
        name: 'staged',
        tools: [],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toContain('## staged');
    expect(text).not.toContain('Available tools:');
    expect(text.trim()).toBe('## staged');
  });

  it('separates servers with blank lines and labels tool lists', () => {
    const servers: CatalogServer[] = [
      {
        name: 'alpha',
        description: 'Alpha server',
        tools: [{ name: 'a1', inputSchema: { type: 'object' } }],
      },
      {
        name: 'beta',
        tools: [{ name: 'b1', inputSchema: { type: 'object' } }],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toBe(
      '## alpha\nAlpha server\n\nAvailable tools:\na1\n\n## beta\n\nAvailable tools:\nb1',
    );
  });
});
