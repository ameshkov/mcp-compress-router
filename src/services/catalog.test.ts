import { describe, it, expect } from 'vitest';
import { buildCatalog, lookupTools } from './catalog.js';
import type { DiscoveredServer } from './discovery.js';

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

  it('throws for unknown server', () => {
    expect(() => lookupTools(catalog, 'unknown', ['a'])).toThrow(/unknown/);
  });

  it('throws for unknown tool', () => {
    expect(() => lookupTools(catalog, 'srv', ['unknown_tool'])).toThrow(/unknown_tool/);
  });
});
