/**
 * Lifelike weather tools for the real-LLM QA plans.
 *
 * Unlike the generic QA mock tools (`mock-mcp-tools.ts`), these tools
 * model a plausible external service. A real model gets an ordinary
 * task ("I am flying to Berlin tomorrow, will it rain?") and has to
 * discover the tool through the router instead of being told its name,
 * which is what the real-LLM plans verify. The data is fixed so the
 * plans can assert on exact strings ("light rain", "clear skies") in
 * the transcript and the mock server call log.
 *
 * Tools:
 * - `get_forecast(city, days)` — a deterministic multi-day forecast.
 * - `get_current_conditions(city)` — deterministic current weather.
 * - `list_cities()` — the supported cities.
 *
 * The tool set is selected with `MOCK_MCP_TOOLS=weather` in both the
 * stdio mock (`mock-mcp-stdio/server.ts`) and the streamable-http mock
 * (`mock-mcp-http/server.ts`, the `mock-mcp-weather` compose service).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** One forecast day. */
interface ForecastDay {
  /** Expected temperature in degrees Celsius. */
  temperatureC: number;
  /** Short conditions description, e.g. `light rain`. */
  conditions: string;
}

/** Current conditions for one city. */
interface CurrentConditions {
  temperatureC: number;
  conditions: string;
}

/** One supported city with its fixed forecast and current conditions. */
interface WeatherCity {
  name: string;
  forecast: readonly ForecastDay[];
  current: CurrentConditions;
}

/** Forecast days returned when the caller does not ask for a count. */
const DEFAULT_FORECAST_DAYS = 3;

/** The fixed weather dataset the plans assert on. */
const CITIES: readonly WeatherCity[] = [
  {
    name: 'Berlin',
    forecast: [
      { temperatureC: 17, conditions: 'light rain' },
      { temperatureC: 19, conditions: 'cloudy' },
      { temperatureC: 21, conditions: 'sunny' },
    ],
    current: { temperatureC: 15, conditions: 'overcast' },
  },
  {
    name: 'Lisbon',
    forecast: [
      { temperatureC: 26, conditions: 'sunny' },
      { temperatureC: 25, conditions: 'sunny' },
      { temperatureC: 24, conditions: 'partly cloudy' },
    ],
    current: { temperatureC: 24, conditions: 'clear skies' },
  },
  {
    name: 'Reykjavík',
    forecast: [
      { temperatureC: 6, conditions: 'windy with sleet' },
      { temperatureC: 5, conditions: 'light snow' },
      { temperatureC: 7, conditions: 'cloudy' },
    ],
    current: { temperatureC: 4, conditions: 'strong wind' },
  },
  {
    name: 'Tokyo',
    forecast: [
      { temperatureC: 23, conditions: 'clear skies' },
      { temperatureC: 24, conditions: 'humid' },
      { temperatureC: 22, conditions: 'light rain' },
    ],
    current: { temperatureC: 25, conditions: 'humid' },
  },
];

/** Names of the tools registered by {@link createWeatherMcpServer}. */
export const WEATHER_TOOL_NAMES: readonly string[] = [
  'get_forecast',
  'get_current_conditions',
  'list_cities',
];

/** The supported city names, in dataset order. */
export const WEATHER_CITIES: readonly string[] = CITIES.map((city) => city.name);

/**
 * Finds a supported city by name, case-insensitively.
 *
 * @param name - The city name as provided by the caller.
 * @returns The matching city, or `undefined` when it is not supported.
 */
function findCity(name: string): WeatherCity | undefined {
  const normalized = name.trim().toLowerCase();
  return CITIES.find((city) => city.name.toLowerCase() === normalized);
}

/**
 * Formats one city's forecast for the given number of days.
 *
 * @param city - The matching city.
 * @param days - How many days to include; clamped to the fixed data.
 * @returns The forecast text, one line per day.
 */
function formatForecast(city: WeatherCity, days: number): string {
  const shown = city.forecast.slice(0, Math.max(1, Math.min(days, city.forecast.length)));
  const lines = shown.map((day, index) => {
    const label = index === 0 ? 'Tomorrow' : `In ${index + 1} days`;
    return `${label}: ${day.temperatureC}°C, ${day.conditions}.`;
  });
  return `Forecast for ${city.name}:\n${lines.join('\n')}`;
}

/**
 * Builds the guided error for an unsupported city.
 *
 * @param name - The city name as provided by the caller.
 * @returns An `isError` tool result listing the supported cities.
 */
function unsupportedCityResult(name: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `No weather data for "${name}". Supported cities: ${WEATHER_CITIES.join(', ')}.`,
      },
    ],
    isError: true as const,
  };
}

/**
 * Registers the `get_forecast` tool.
 *
 * @param server - The mock MCP server.
 */
function registerGetForecast(server: McpServer): void {
  server.registerTool(
    'get_forecast',
    {
      title: 'Get Forecast',
      description: 'Returns the daily weather forecast for a supported city.',
      inputSchema: {
        city: z.string().describe('The city to forecast, for example "Berlin".'),
        days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`How many days to include (default ${DEFAULT_FORECAST_DAYS}).`),
      },
    },
    async (params) => {
      const city = findCity(params.city);
      if (!city) {
        return unsupportedCityResult(params.city);
      }
      const days = params.days ?? DEFAULT_FORECAST_DAYS;
      return { content: [{ type: 'text' as const, text: formatForecast(city, days) }] };
    },
  );
}

/**
 * Registers the `get_current_conditions` tool.
 *
 * @param server - The mock MCP server.
 */
function registerGetCurrentConditions(server: McpServer): void {
  server.registerTool(
    'get_current_conditions',
    {
      title: 'Get Current Conditions',
      description: 'Returns the current weather for a supported city.',
      inputSchema: {
        city: z.string().describe('The city to look up, for example "Lisbon".'),
      },
    },
    async (params) => {
      const city = findCity(params.city);
      if (!city) {
        return unsupportedCityResult(params.city);
      }
      const { temperatureC, conditions } = city.current;
      const text = `Current conditions in ${city.name}: ${temperatureC}°C, ${conditions}.`;
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}

/**
 * Registers the `list_cities` tool.
 *
 * @param server - The mock MCP server.
 */
function registerListCities(server: McpServer): void {
  server.registerTool(
    'list_cities',
    {
      title: 'List Cities',
      description: 'Lists the cities this weather service supports.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text' as const, text: `Supported cities: ${WEATHER_CITIES.join(', ')}.` }],
    }),
  );
}

/**
 * Creates the lifelike weather mock MCP server.
 *
 * @param name - The server name reported during initialize.
 * @returns The ready-to-connect MCP server.
 */
export function createWeatherMcpServer(name: string): McpServer {
  const server = new McpServer({ name, version: '1.0.0' });
  registerGetForecast(server);
  registerGetCurrentConditions(server);
  registerListCities(server);
  return server;
}
