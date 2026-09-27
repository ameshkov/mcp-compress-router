import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { createWeatherMcpServer, WEATHER_CITIES } from './mock-mcp-weather.js';

/**
 * Connects a fresh weather mock server to an in-memory MCP client.
 *
 * @returns The connected client.
 */
async function connectClient(): Promise<Client> {
  const server = createWeatherMcpServer('qa-mock-weather');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'weather-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/**
 * Extracts the first text content block of a tool result.
 *
 * @param result - The tool result.
 * @returns The text, or an empty string when there is no text block.
 */
function firstText(result: CallToolResult): string {
  const block = result.content[0];
  return block?.type === 'text' ? block.text : '';
}

/**
 * Calls one tool and returns its result.
 *
 * @param client - The connected client.
 * @param name - The tool name.
 * @param args - The tool arguments.
 * @returns The tool result.
 */
function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
}

describe('createWeatherMcpServer', () => {
  it('advertises the weather tools', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'get_forecast',
      'get_current_conditions',
      'list_cities',
    ]);
  });

  it('returns the fixed Berlin forecast', async () => {
    const client = await connectClient();
    const result = await call(client, 'get_forecast', { city: 'Berlin' });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe(
      [
        'Forecast for Berlin:',
        'Tomorrow: 17°C, light rain.',
        'In 2 days: 19°C, cloudy.',
        'In 3 days: 21°C, sunny.',
      ].join('\n'),
    );
  });

  it('matches the city case-insensitively and honors the requested day count', async () => {
    const client = await connectClient();
    const result = await call(client, 'get_forecast', { city: 'berlin', days: 1 });
    expect(firstText(result)).toBe('Forecast for Berlin:\nTomorrow: 17°C, light rain.');
  });

  it('returns the fixed Lisbon current conditions', async () => {
    const client = await connectClient();
    const result = await call(client, 'get_current_conditions', { city: 'Lisbon' });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe('Current conditions in Lisbon: 24°C, clear skies.');
  });

  it('lists every supported city', async () => {
    const client = await connectClient();
    const result = await call(client, 'list_cities', {});
    expect(firstText(result)).toBe(`Supported cities: ${WEATHER_CITIES.join(', ')}.`);
  });

  it('returns a guided error for an unsupported city', async () => {
    const client = await connectClient();
    const result = await call(client, 'get_forecast', { city: 'Atlantis' });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe(
      'No weather data for "Atlantis". Supported cities: Berlin, Lisbon, Reykjavík, Tokyo.',
    );
  });
});
