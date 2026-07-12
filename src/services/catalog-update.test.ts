import { describe, it, expect } from 'vitest';
import { buildCatalog, updateServerInCatalog } from './catalog.js';
import type { DiscoveredServer } from './discovery.js';

describe('updateServerInCatalog', () => {
  const tools: DiscoveredServer['tools'] = [
    {
      name: 't1',
      description: 'Tool 1',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 't2',
      description: 'Tool 2',
      inputSchema: { type: 'object', properties: {} },
    },
  ];

  function buildBaselineCatalog() {
    return buildCatalog([
      {
        name: 'srv',
        tools: [{ name: 'old_tool', inputSchema: { type: 'object' } }],
        status: 'unavailable',
      },
    ]);
  }

  it('replaces the server tools with the new list', () => {
    const catalog = buildBaselineCatalog();
    updateServerInCatalog(catalog, 'srv', tools, 'ok');

    const srv = catalog.servers.find((s) => s.name === 'srv')!;
    expect(srv.tools.map((t) => t.name)).toEqual(['t1', 't2']);
    expect(srv.tools).not.toContain(expect.objectContaining({ name: 'old_tool' }));
  });

  it('updates the server status', () => {
    const catalog = buildBaselineCatalog();
    expect(catalog.servers.find((s) => s.name === 'srv')!.status).toBe('unavailable');

    updateServerInCatalog(catalog, 'srv', tools, 'ok');

    expect(catalog.servers.find((s) => s.name === 'srv')!.status).toBe('ok');
  });

  it('updates the toolMap with new entries', () => {
    const catalog = buildBaselineCatalog();
    expect(catalog.toolMap.has('srv::old_tool')).toBe(true);

    updateServerInCatalog(catalog, 'srv', tools, 'ok');

    expect(catalog.toolMap.has('srv::t1')).toBe(true);
    expect(catalog.toolMap.has('srv::t2')).toBe(true);
    expect(catalog.toolMap.has('srv::old_tool')).toBe(false);
  });

  it('applies tool selection (allowedTools)', () => {
    const catalog = buildBaselineCatalog();
    updateServerInCatalog(catalog, 'srv', tools, 'ok', {
      allowedTools: ['t1'],
    });

    const srv = catalog.servers.find((s) => s.name === 'srv')!;
    expect(srv.tools.map((t) => t.name)).toEqual(['t1']);
    expect(catalog.toolMap.has('srv::t1')).toBe(true);
    expect(catalog.toolMap.has('srv::t2')).toBe(false);
    expect(catalog.filteredToolNames.has('srv::t2')).toBe(true);
  });

  it('applies tool selection (disabledTools)', () => {
    const catalog = buildBaselineCatalog();
    updateServerInCatalog(catalog, 'srv', tools, 'ok', {
      disabledTools: ['t2'],
    });

    const srv = catalog.servers.find((s) => s.name === 'srv')!;
    expect(srv.tools.map((t) => t.name)).toEqual(['t1']);
    expect(catalog.toolMap.has('srv::t2')).toBe(false);
    expect(catalog.filteredToolNames.has('srv::t2')).toBe(true);
  });

  it('is a no-op when the server is not in the catalog', () => {
    const catalog = buildBaselineCatalog();
    const original = JSON.parse(JSON.stringify(catalog.servers));

    updateServerInCatalog(catalog, 'nonexistent', tools, 'ok');

    expect(catalog.servers).toEqual(original);
  });
});
