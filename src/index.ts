/// <reference types="node" />

import { Command } from 'commander';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  resolveConfigPath,
  loadConfig,
  connectAndDiscover,
  buildCatalog,
} from './services/index.js';
import {
  createGetToolSchemaHandler,
  buildGetToolSchemaDescription,
  GetToolSchemaInputSchema,
  createInvokeToolHandler,
  InvokeToolInputSchema,
} from './tools/index.js';

async function main() {
  const program = new Command();

  program
    .name('mcp-compress-router')
    .description('Compress all connected MCP servers into a single router MCP')
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .parse();

  const options = program.opts<{ config?: string }>();
  const resolved = resolveConfigPath(options.config);

  console.error(`[mcp-compress-router] Loading config from: ${resolved}`);

  const servers = await loadConfig(resolved);
  console.error(`[mcp-compress-router] Loaded ${servers.length} downstream server(s)`);

  console.error('[mcp-compress-router] Connecting to downstream servers...');
  const discovered = await connectAndDiscover(servers);
  console.error(
    `[mcp-compress-router] Discovered tools: ${discovered.map((d) => `${d.name} (${d.tools.length} tools)`).join(', ')}`,
  );

  const catalog = buildCatalog(discovered);

  const router = new McpServer({
    name: 'mcp-compress-router',
    version: '1.0.0',
  });

  router.registerTool(
    'get_tool_schema',
    {
      title: 'Get Tool Schema',
      description: buildGetToolSchemaDescription(catalog),
      inputSchema: GetToolSchemaInputSchema,
    },
    createGetToolSchemaHandler(catalog),
  );

  router.registerTool(
    'invoke_tool',
    {
      title: 'Invoke Tool',
      description:
        'Invoke a specific tool on a connected MCP server. First use get_tool_schema to retrieve the required parameters.',
      inputSchema: InvokeToolInputSchema,
    },
    createInvokeToolHandler(),
  );

  const transport = new StdioServerTransport();
  await router.connect(transport);
  console.error('[mcp-compress-router] Server started on stdio');
}

main().catch((err) => {
  console.error('[mcp-compress-router] Fatal error:', err);
  process.exit(1);
});
