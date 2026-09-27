import { describe, expect, it } from 'vitest';
import {
  getMockServerSummary,
  getMockTools,
  isMockServerName,
  MOCK_SERVER_NAMES,
} from './registry.js';

describe('mock MCP server registry', () => {
  it('exposes the four benchmark server surfaces', () => {
    expect(MOCK_SERVER_NAMES).toEqual(['notion', 'github', 'figma', 'playwright']);
    for (const name of MOCK_SERVER_NAMES) {
      expect(isMockServerName(name)).toBe(true);
    }
    expect(isMockServerName('does-not-exist')).toBe(false);
  });

  it('advertises a realistic tool count per server', () => {
    const summary = getMockServerSummary();
    expect(summary).toEqual([
      { name: 'notion', tools: 12 },
      { name: 'github', tools: 20 },
      { name: 'figma', tools: 12 },
      { name: 'playwright', tools: 15 },
    ]);
    const total = summary.reduce((sum, server) => sum + server.tools, 0);
    expect(total).toBeGreaterThanOrEqual(50);
  });

  it('defines every tool with a unique name and a usable schema', () => {
    for (const name of MOCK_SERVER_NAMES) {
      const tools = getMockTools(name);
      const names = tools.map((tool) => tool.name);
      expect(new Set(names).size).toBe(names.length);
      for (const tool of tools) {
        expect(tool.name.length).toBeGreaterThan(0);
        expect(tool.description?.length ?? 0).toBeGreaterThan(20);
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
        for (const required of tool.inputSchema.required ?? []) {
          expect(Object.keys(tool.inputSchema.properties ?? {})).toContain(required);
        }
      }
    }
  });
});
