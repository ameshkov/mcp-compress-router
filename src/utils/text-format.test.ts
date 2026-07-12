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
        status: 'ok',
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
        status: 'ok',
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
        status: 'ok',
        tools: [{ name: 'a1', inputSchema: { type: 'object' } }],
      },
      {
        name: 'beta',
        compressionLevel: 'high',
        status: 'ok',
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
        status: 'ok',
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
        status: 'ok',
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
        status: 'ok',
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

  it('renders max level tools as a single comma-separated line', () => {
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

    expect(text).toBe('## srv\n\nAvailable tools:\ntool1, tool2, tool3');
  });

  it('renders max level with description showing header then comma-separated names', () => {
    const servers: CatalogServer[] = [
      {
        name: 'srv',
        description: 'A server',
        compressionLevel: 'max',
        status: 'ok',
        tools: [
          { name: 'a', inputSchema: { type: 'object' } },
          { name: 'b', inputSchema: { type: 'object' } },
        ],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toBe('## srv\nA server\n\nAvailable tools:\na, b');
  });

  it('renders max level with zero tools as just a header', () => {
    const servers: CatalogServer[] = [
      { name: 'empty', compressionLevel: 'max', status: 'ok', tools: [] },
    ];

    const text = renderCompactCatalog(servers);

    expect(text.trim()).toBe('## empty');
    expect(text).not.toContain('Available tools:');
  });

  it('renders medium level with the first sentence under 10 words and no ellipsis', () => {
    const servers: CatalogServer[] = [
      {
        name: 'srv',
        compressionLevel: 'medium',
        status: 'ok',
        tools: [
          {
            name: 'fetch',
            description: 'Fetches a URL and returns the raw content. Supports timeout.',
            inputSchema: {
              type: 'object',
              properties: { url: { type: 'string' }, timeout: { type: 'number' } },
            },
          },
        ],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toContain('fetch(url, timeout): Fetches a URL and returns the raw content');
    expect(text).not.toContain('...');
  });

  it('renders medium level with an ellipsis when the first sentence exceeds 10 words', () => {
    const servers: CatalogServer[] = [
      {
        name: 'srv',
        compressionLevel: 'medium',
        status: 'ok',
        tools: [
          {
            name: 'fetch',
            description:
              'This particular tool fetches data from a remote URL endpoint with optional timeout.',
            inputSchema: {
              type: 'object',
              properties: { url: { type: 'string' }, timeout: { type: 'number' } },
            },
          },
        ],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toContain(
      'fetch(url, timeout): This particular tool fetches data from a remote URL endpoint...',
    );
  });

  it('renders medium level with no description as name(args) with no colon', () => {
    const servers: CatalogServer[] = [
      {
        name: 'srv',
        compressionLevel: 'medium',
        status: 'ok',
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
    expect(text).not.toMatch(/fetch\(url, timeout\):/);
  });

  it('renders medium level with a no-period description as the whole string', () => {
    const servers: CatalogServer[] = [
      {
        name: 'srv',
        compressionLevel: 'medium',
        status: 'ok',
        tools: [
          {
            name: 'ping',
            description: 'No period in this description',
            inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
          },
        ],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toContain('ping(url): No period in this description');
  });

  it('renders low level with full description wrapped in tool tags', () => {
    const servers: CatalogServer[] = [
      {
        name: 'srv',
        compressionLevel: 'low',
        status: 'ok',
        tools: [
          {
            name: 'fetch',
            description: 'Fetch a URL. Returns the raw content.',
            inputSchema: {
              type: 'object',
              properties: { url: { type: 'string' }, timeout: { type: 'number' } },
            },
          },
        ],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toContain(
      '<tool>fetch(url, timeout): Fetch a URL. Returns the raw content.</tool>',
    );
  });

  it('renders low level with no description as tool tags around the signature', () => {
    const servers: CatalogServer[] = [
      {
        name: 'srv',
        compressionLevel: 'low',
        status: 'ok',
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

    expect(text).toContain('<tool>fetch(url, timeout)</tool>');
  });

  it('renders low level with a multi-paragraph description verbatim inside tool tags', () => {
    const servers: CatalogServer[] = [
      {
        name: 'srv',
        compressionLevel: 'low',
        status: 'ok',
        tools: [
          {
            name: 'fetch',
            description: 'First paragraph.\n\nSecond paragraph.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toContain('<tool>fetch(): First paragraph.\n\nSecond paragraph.</tool>');
  });

  it('renders low level with each tool on its own tagged line', () => {
    const servers: CatalogServer[] = [
      {
        name: 'srv',
        compressionLevel: 'low',
        status: 'ok',
        tools: [
          {
            name: 'a',
            description: 'Tool A',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'b',
            description: 'Tool B',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toContain('<tool>a(): Tool A</tool>');
    expect(text).toContain('<tool>b(): Tool B</tool>');
  });

  it('renders a mixed-level multi-server catalog with each server using its own format', () => {
    const servers: CatalogServer[] = [
      {
        name: 'server-a',
        compressionLevel: 'max',
        status: 'ok',
        tools: [
          { name: 'tool1', inputSchema: { type: 'object' } },
          { name: 'tool2', inputSchema: { type: 'object' } },
        ],
      },
      {
        name: 'server-b',
        description: 'Server B',
        // 'high' is the resolved default when no compressionLevel field
        // is set in the config (resolution happens in the catalog
        // builder, not the renderer).
        compressionLevel: 'high',
        status: 'ok',
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
      {
        name: 'server-c',
        compressionLevel: 'low',
        status: 'ok',
        tools: [
          {
            name: 'ping',
            description: 'Health check.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toBe(
      '## server-a\n\nAvailable tools:\ntool1, tool2' +
        '\n\n## server-b\nServer B\n\nAvailable tools:\nfetch(url, timeout)' +
        '\n\n## server-c\n\nAvailable tools:\n<tool>ping(): Health check.</tool>',
    );
  });

  it('renders a status header for an unauthorized server', () => {
    const servers: CatalogServer[] = [
      {
        name: 'figma',
        compressionLevel: 'high',
        status: 'unauthorized',
        tools: [{ name: 'get_file', inputSchema: { type: 'object', properties: {} } }],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toContain('## figma');
    expect(text).toContain('Requires authentication');
    expect(text).toContain('npx mcp-compress-router login figma');
    expect(text).toContain('get_file()');
  });

  it('renders a status header for an unavailable server', () => {
    const servers: CatalogServer[] = [
      {
        name: 'my-api',
        compressionLevel: 'high',
        status: 'unavailable',
        tools: [],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toContain('## my-api');
    expect(text).toContain('unavailable');
  });

  it('does not render a status header for an ok server', () => {
    const servers: CatalogServer[] = [
      {
        name: 'fixture',
        compressionLevel: 'high',
        status: 'ok',
        tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
      },
    ];

    const text = renderCompactCatalog(servers);

    expect(text).toContain('## fixture');
    expect(text).not.toContain('Requires authentication');
    expect(text).not.toContain('unavailable');
  });
});
