import { describe, it, expect, vi } from 'vitest';
import { buildCatalog, lookupTools } from './catalog.js';
import type { DiscoveredServer } from './discovery.js';
import type { ToolSelection } from '../utils/index.js';
import { Logger } from '../utils/logger.js';

describe('buildCatalog', () => {
  it('builds an immutable catalog with tool map', () => {
    const discovered: DiscoveredServer[] = [
      {
        name: 'srv1',
        description: 'First server',
        tools: [
          {
            name: 't1',
            description: 'Tool 1',
            inputSchema: {
              type: 'object',
              properties: { x: { type: 'string' } },
            },
          },
          {
            name: 't2',
            description: 'Tool 2',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
      {
        name: 'srv2',
        tools: [
          {
            name: 't3',
            description: 'Tool 3',
            inputSchema: {
              type: 'object',
              properties: { y: { type: 'number' } },
            },
          },
        ],
      },
    ];

    const catalog = buildCatalog(discovered);
    expect(catalog.servers).toHaveLength(2);
    expect(catalog.servers[0].name).toBe('srv1');
    expect(catalog.servers[0].description).toBe('First server');
    expect(catalog.servers[0].tools).toHaveLength(2);
    expect(catalog.servers[1].name).toBe('srv2');
    expect(catalog.servers[1].tools).toHaveLength(1);
  });
});

describe('lookupTools', () => {
  const catalog = buildCatalog([
    {
      name: 'srv',
      tools: [
        {
          name: 'a',
          description: 'Tool A',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'b',
          description: 'Tool B',
          inputSchema: {
            type: 'object',
            properties: { key: { type: 'string' } },
          },
        },
      ],
    },
  ]);

  it('returns schemas for valid tool names', () => {
    const result = lookupTools(catalog, 'srv', ['a']);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('a');
    expect(result[0].description).toBe('Tool A');
    expect(result[0].inputSchema).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('returns multiple tools', () => {
    const result = lookupTools(catalog, 'srv', ['a', 'b']);
    expect(result).toHaveLength(2);
  });

  it('throws for unknown server listing valid servers', () => {
    expect(() => lookupTools(catalog, 'unknown', ['a'])).toThrow(/unknown/);
    expect(() => lookupTools(catalog, 'unknown', ['a'])).toThrow(/Available servers: srv/);
  });

  it('throws for unknown tool listing valid tools', () => {
    expect(() => lookupTools(catalog, 'srv', ['unknown_tool'])).toThrow(/unknown_tool/);
    expect(() => lookupTools(catalog, 'srv', ['unknown_tool'])).toThrow(/Valid tools: a, b/);
  });

  it('throws when one of multiple tool names is unknown — not partial', () => {
    expect(() => lookupTools(catalog, 'srv', ['a', 'nonexistent'])).toThrow(/nonexistent/);
  });
});

describe('buildCatalog — disabled servers contract', () => {
  it('excludes a server that was not discovered (disabled servers never reach it)', () => {
    // Simulate the post-Task-1 reality: discovery omits the disabled
    // server, so buildCatalog receives only the enabled server.
    const discovered: DiscoveredServer[] = [
      {
        name: 'enabled-srv',
        tools: [
          {
            name: 't',
            description: 'Tool T',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
      // Note: no entry for the disabled server here — discovery
      // already skipped it.
    ];

    const catalog = buildCatalog(discovered);

    expect(catalog.servers).toHaveLength(1);
    expect(catalog.servers.find((s) => s.name === 'disabled-srv')).toBeUndefined();
    expect(catalog.toolMap.has('disabled-srv::t')).toBe(false);
    expect(catalog.toolMap.has('enabled-srv::t')).toBe(true);
  });
});

describe('buildCatalog — tool selection', () => {
  const fullServer: DiscoveredServer = {
    name: 'github',
    description: 'GitHub server',
    tools: [
      {
        name: 'list_issues',
        description: 'List issues',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_pull_request',
        description: 'Get PR',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'delete_repo',
        description: 'Delete repo',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };

  it('allowlist exposes only matching tools and records filtered names', () => {
    const selection = new Map<string, ToolSelection>([
      ['github', { allowedTools: ['list_issues', 'get_pull_request'] }],
    ]);

    const catalog = buildCatalog([fullServer], selection);

    const srv = catalog.servers.find((s) => s.name === 'github')!;
    expect(srv.tools.map((t) => t.name).sort()).toEqual(['get_pull_request', 'list_issues']);

    expect(catalog.toolMap.has('github::list_issues')).toBe(true);
    expect(catalog.toolMap.has('github::get_pull_request')).toBe(true);
    expect(catalog.toolMap.has('github::delete_repo')).toBe(false);

    expect(catalog.filteredToolNames.has('github::delete_repo')).toBe(true);
    expect(catalog.filteredToolNames.has('github::list_issues')).toBe(false);
  });

  it('empty allowlist exposes zero tools but the server still appears', () => {
    const selection = new Map<string, ToolSelection>([['github', { allowedTools: [] }]]);

    const catalog = buildCatalog([fullServer], selection);

    const srv = catalog.servers.find((s) => s.name === 'github')!;
    expect(srv.tools).toHaveLength(0);
    expect(catalog.servers).toHaveLength(1);

    expect(catalog.toolMap.has('github::list_issues')).toBe(false);
    expect(catalog.toolMap.has('github::delete_repo')).toBe(false);

    expect(catalog.filteredToolNames.has('github::list_issues')).toBe(true);
    expect(catalog.filteredToolNames.has('github::delete_repo')).toBe(true);
  });

  it('denylist hides matching tools', () => {
    const selection = new Map<string, ToolSelection>([
      ['github', { disabledTools: ['delete_repo'] }],
    ]);

    const catalog = buildCatalog([fullServer], selection);

    const srv = catalog.servers.find((s) => s.name === 'github')!;
    expect(srv.tools.map((t) => t.name).sort()).toEqual(['get_pull_request', 'list_issues']);
    expect(catalog.toolMap.has('github::delete_repo')).toBe(false);
    expect(catalog.filteredToolNames.has('github::delete_repo')).toBe(true);
  });

  it('denylist wins when a tool matches both allowlist and denylist', () => {
    const selection = new Map<string, ToolSelection>([
      [
        'github',
        {
          allowedTools: ['list_issues', 'delete_repo'],
          disabledTools: ['delete_repo'],
        },
      ],
    ]);

    const catalog = buildCatalog([fullServer], selection);

    expect(catalog.toolMap.has('github::list_issues')).toBe(true);
    expect(catalog.toolMap.has('github::delete_repo')).toBe(false);
    expect(catalog.filteredToolNames.has('github::delete_repo')).toBe(true);
  });
});

describe('lookupTools — filtered tools', () => {
  const server: DiscoveredServer = {
    name: 'github',
    tools: [
      {
        name: 'echo',
        description: 'Echo',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'delete_repo',
        description: 'Delete',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };

  const catalog = buildCatalog(
    [server],
    new Map<string, ToolSelection>([['github', { allowedTools: ['echo'] }]]),
  );

  it('errors with a "filtered out" message for a filtered tool', () => {
    expect(() => lookupTools(catalog, 'github', ['delete_repo'])).toThrow(/filtered out/);
    expect(() => lookupTools(catalog, 'github', ['delete_repo'])).toThrow(/delete_repo/);
  });

  it('still reports "not found" for a tool that does not exist', () => {
    expect(() => lookupTools(catalog, 'github', ['nope'])).toThrow(/not found/);
    expect(() => lookupTools(catalog, 'github', ['nope'])).not.toThrow(/filtered out/);
  });

  it('returns exposed tools normally', () => {
    const result = lookupTools(catalog, 'github', ['echo']);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('echo');
  });
});

describe('buildCatalog — unmatched-pattern warnings', () => {
  const server: DiscoveredServer = {
    name: 'github',
    description: 'GitHub server',
    tools: [
      {
        name: 'list_issues',
        description: 'List issues',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };

  it('logs a debug warning per unmatched allowlist pattern', () => {
    const logger = new Logger('debug');
    const debugSpy = vi.spyOn(logger, 'debug');

    const selection = new Map<string, ToolSelection>([
      ['github', { allowedTools: ['list_issues', 'ghost_tool', 'missing_*'] }],
    ]);

    buildCatalog([server], selection, logger);

    const messages = debugSpy.mock.calls.map((c) => c[0]);
    expect(messages.some((m) => m.includes('ghost_tool'))).toBe(true);
    expect(messages.some((m) => m.includes('missing_*'))).toBe(true);
    expect(messages.every((m) => !m.includes('list_issues'))).toBe(true);

    const ghostCall = debugSpy.mock.calls.find((c) => c[0].includes('ghost_tool'))!;
    expect(ghostCall[1]).toMatchObject({ server: 'github', pattern: 'ghost_tool' });
  });

  it('logs a debug warning per unmatched denylist pattern', () => {
    const logger = new Logger('debug');
    const debugSpy = vi.spyOn(logger, 'debug');

    const selection = new Map<string, ToolSelection>([
      ['github', { disabledTools: ['never_seen_*', 'admin_purge'] }],
    ]);

    buildCatalog([server], selection, logger);

    const messages = debugSpy.mock.calls.map((c) => c[0]);
    expect(messages.some((m) => m.includes('never_seen_*'))).toBe(true);
    expect(messages.some((m) => m.includes('admin_purge'))).toBe(true);
  });

  it('does not log when no patterns are unmatched', () => {
    const logger = new Logger('debug');
    const debugSpy = vi.spyOn(logger, 'debug');

    const selection = new Map<string, ToolSelection>([
      ['github', { allowedTools: ['list_issues'] }],
    ]);

    buildCatalog([server], selection, logger);

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('suppresses warnings at default (info) level — verbose only', () => {
    const infoLogger = new Logger('info');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const selection = new Map<string, ToolSelection>([
      ['github', { allowedTools: ['ghost_tool'] }],
    ]);

    buildCatalog([server], selection, infoLogger);

    try {
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('still returns a valid catalog when warnings fire', () => {
    const logger = new Logger('debug');
    vi.spyOn(logger, 'debug');

    const selection = new Map<string, ToolSelection>([
      ['github', { allowedTools: ['list_issues', 'ghost_tool'] }],
    ]);

    const catalog = buildCatalog([server], selection, logger);

    expect(catalog.servers).toHaveLength(1);
    const srv = catalog.servers.find((s) => s.name === 'github')!;
    expect(srv.tools.map((t) => t.name)).toEqual(['list_issues']);
  });

  it('works when no logger is supplied (backward compatible)', () => {
    const selection = new Map<string, ToolSelection>([
      ['github', { allowedTools: ['ghost_tool'] }],
    ]);

    expect(() => buildCatalog([server], selection)).not.toThrow();
  });
});
