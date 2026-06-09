/// <reference types="node" />

import { Command } from 'commander';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  resolveConfigPath,
  loadConfig,
  connectAndDiscover,
  buildCatalog,
  invokeDownstreamTool,
  OAuthCredentialManager,
} from './services/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { DownstreamServerConfig } from './utils/index.js';
import {
  createGetToolSchemaHandler,
  buildGetToolSchemaDescription,
  GetToolSchemaInputSchema,
  createInvokeToolHandler,
  InvokeToolInputSchema,
} from './tools/index.js';
import { Logger } from './utils/index.js';
import {
  handleAdd,
  handleRemove,
  handleGet,
  handleList,
  handleLogin,
  handleLogout,
} from './cli/index.js';

/**
 * Collects repeated `--header "K: V"` flags into a headers record.
 * @internal — Exported for tests only; not part of the public module API.
 */
export function collectHeaders(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const colonIdx = value.indexOf(':');
  if (colonIdx === -1) {
    throw new Error(`Invalid header format: "${value}". Expected "Key: Value".`);
  }
  const key = value.slice(0, colonIdx).trim();
  const val = value.slice(colonIdx + 1).trim();
  return { ...previous, [key]: val };
}

/**
 * Collects repeated `-e KEY=value` flags into an env record.
 * @internal — Exported for tests only; not part of the public module API.
 */
export function collectEnv(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const eqIdx = value.indexOf('=');
  if (eqIdx === -1) {
    throw new Error(`Invalid env format: "${value}". Expected "KEY=value".`);
  }
  const key = value.slice(0, eqIdx);
  const val = value.slice(eqIdx + 1);
  return { ...previous, [key]: val };
}

async function runRouter(configPath: string | undefined, verbose: boolean) {
  const logger = new Logger(verbose ? 'debug' : 'info');

  logger.info('Starting mcp-compress-router', {
    verbose,
    config: configPath ?? '(default)',
  });

  const resolved = resolveConfigPath(configPath);
  logger.info('Loading configuration', { path: resolved });

  const servers = await loadConfig(resolved);
  logger.info('Configuration loaded', { serverCount: servers.length });

  // Create OAuth credential managers for HTTP servers that have stored
  // credentials or oauth overrides, so the transport can handle auth.
  const authProviders = new Map<string, OAuthClientProvider>();
  for (const server of servers) {
    if (server.type === 'http' || server.type === 'streamable-http') {
      const mgr = new OAuthCredentialManager(resolved, server);
      const hasCredentials = (await mgr.tokens()) !== undefined;
      const hasOverrides = server.oauth?.clientId !== undefined;
      if (hasCredentials || hasOverrides) {
        authProviders.set(server.name, mgr);
      }
    }
  }

  const getAuthProvider = (server: DownstreamServerConfig) => authProviders.get(server.name);

  logger.info('Connecting to downstream servers', {
    servers: servers.map((s) => s.name),
  });
  const { servers: discovered, clients } = await connectAndDiscover(
    servers,
    logger,
    getAuthProvider,
  );
  logger.info('Tools discovered', {
    servers: discovered.map((d) => ({
      name: d.name,
      toolCount: d.tools.length,
      tools: d.tools.map((t) => t.name),
    })),
  });

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
    createGetToolSchemaHandler(catalog, logger),
  );

  const invokeFn = (server: string, tool: string, args: Record<string, unknown>) =>
    invokeDownstreamTool(clients, server, tool, args, logger);

  router.registerTool(
    'invoke_tool',
    {
      title: 'Invoke Tool',
      description:
        'Invoke a specific tool on a connected MCP server. First use get_tool_schema to retrieve the required parameters.',
      inputSchema: InvokeToolInputSchema,
    },
    createInvokeToolHandler(catalog, invokeFn, logger),
  );

  const transport = new StdioServerTransport();
  await router.connect(transport);
  logger.info('Server started on stdio');
}

async function main() {
  const program = new Command();

  program
    .name('mcp-compress-router')
    .description('Compress all connected MCP servers into a single router MCP');

  // --- Management subcommands ---

  program
    .command('add <name> <commandOrUrl> [rest...]')
    .description('Add a downstream MCP server to the configuration')
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .option('--transport <type>', 'transport type (stdio or http)', 'stdio')
    .option('--header <header>', 'HTTP header (Key: Value)', collectHeaders, {})
    .option('-e, --env <env>', 'environment variable (KEY=value)', collectEnv, {})
    .action(async (name, commandOrUrl, rest, options) => {
      try {
        const configPath = resolveConfigPath(options.config);
        const result = await handleAdd(configPath, {
          name,
          transport: options.transport,
          commandOrUrl,
          rest,
          env: Object.keys(options.env).length > 0 ? options.env : undefined,
          headers: Object.keys(options.header).length > 0 ? options.header : undefined,
        });
        process.stdout.write(result + '\n');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  program
    .command('remove <name>')
    .description('Remove a downstream MCP server from the configuration')
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .action(async (name, options) => {
      try {
        const configPath = resolveConfigPath(options.config);
        const result = await handleRemove(configPath, name);
        process.stdout.write(result + '\n');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  program
    .command('get <name>')
    .description('Show details for a configured downstream MCP server')
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .action(async (name, options) => {
      try {
        const configPath = resolveConfigPath(options.config);
        const result = await handleGet(configPath, name);
        process.stdout.write(result + '\n');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  program
    .command('list')
    .description('List all configured downstream MCP servers')
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .action(async (options) => {
      try {
        const configPath = resolveConfigPath(options.config);
        const result = await handleList(configPath);
        if (result) {
          process.stdout.write(result + '\n');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  program
    .command('login <name>')
    .description('Authenticate a downstream server using OAuth')
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .action(async (name, options) => {
      try {
        const configPath = resolveConfigPath(options.config);
        const result = await handleLogin(configPath, name);
        process.stdout.write(result + '\n');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  program
    .command('logout <name>')
    .description('Revoke and remove OAuth credentials for a downstream server')
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .action(async (name, options) => {
      try {
        const configPath = resolveConfigPath(options.config);
        const result = await handleLogout(configPath, name);
        process.stdout.write(result + '\n');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  // --- Router mode (default, no subcommand) ---
  program
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .option('-v, --verbose', 'enable debug-level logging to stderr')
    .action(async (options) => {
      const verbose = options.verbose || process.env.MCP_COMPRESS_ROUTER_VERBOSE === 'true';
      await runRouter(options.config, verbose);
    });

  await program.parseAsync();
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);

  // Use a fresh error-level logger for fatal startup errors.
  const fatalLogger = new Logger('debug');

  if (message.includes('Failed to connect to server')) {
    fatalLogger.error('Cannot build complete tool catalog — downstream connection failed', {
      error: message,
    });
  } else {
    fatalLogger.error('Fatal startup error', { error: message });
  }

  process.exitCode = 1;
  process.exit(1);
});
