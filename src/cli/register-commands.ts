import { Command } from 'commander';
import { resolveConfigPath } from '../services/index.js';
import {
  handleAdd,
  handleRemove,
  handleGet,
  handleList,
  handleLogin,
  handleLogout,
  handleEnable,
  handleDisable,
  handleTools,
  type AddOptions,
  type LoginOptions,
} from './index.js';
import {
  collectEnv,
  collectHeaders,
  collectStringArray,
  parseClientName,
  parseClientUri,
  parsePort,
} from './option-parsers.js';
import { runRouter } from './router-runner.js';

/**
 * Wraps a CLI action handler with error handling.
 * On success, writes the result to stdout. On error, writes to stderr
 * and exits with code 1.
 */
function guardedAction<T extends unknown[]>(
  fn: (...args: T) => Promise<string | undefined>,
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      const result = await fn(...args);
      if (result) {
        process.stdout.write(result + '\n');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${message}\n`);
      process.exit(1);
    }
  };
}

/** Commander options shape for the `add` command. */
interface AddCommandOptions {
  config?: string;
  transport: string;
  header: Record<string, string>;
  env: Record<string, string>;
  description?: string;
  enabled?: boolean;
  disabled?: boolean;
  allowedTools: string[];
  disabledTools: string[];
  port?: number;
  clientName?: string;
  clientUri?: string;
  browser?: boolean;
}

/**
 * Commander options shape for the `login` command.
 */
interface LoginCommandOptions {
  config?: string;
  port?: number;
  clientName?: string;
  clientUri?: string;
  browser?: boolean;
}

/**
 * Builds the {@link AddOptions} DTO from the parsed commander options.
 */
function buildAddOptions(
  name: string,
  commandOrUrl: string,
  rest: string[],
  options: AddCommandOptions,
): AddOptions {
  return {
    name,
    transport: options.transport,
    commandOrUrl,
    rest,
    env: Object.keys(options.env).length > 0 ? options.env : undefined,
    headers: Object.keys(options.header).length > 0 ? options.header : undefined,
    description: options.description || undefined,
    enabled: options.enabled || undefined,
    disabled: options.disabled || undefined,
    allowedTools:
      options.allowedTools && options.allowedTools.length > 0 ? options.allowedTools : undefined,
    disabledTools:
      options.disabledTools && options.disabledTools.length > 0 ? options.disabledTools : undefined,
    port: options.port,
    clientName: options.clientName,
    clientUri: options.clientUri,
    noBrowser: options.browser === false ? true : undefined,
  };
}

/**
 * Resolves the config path and runs the `add` handler with the parsed
 * commander options.
 *
 * @param name - Server name.
 * @param commandOrUrl - Command (stdio) or URL (HTTP).
 * @param rest - Additional positional arguments after commandOrUrl.
 * @param options - Parsed commander options.
 * @returns The handler's confirmation message.
 */
async function runAddCommand(
  name: string,
  commandOrUrl: string,
  rest: string[],
  options: AddCommandOptions,
): Promise<string> {
  const configPath = await resolveConfigPath(options.config);
  return handleAdd(configPath, buildAddOptions(name, commandOrUrl, rest, options));
}

function registerAddCommand(program: Command): void {
  program
    .command('add <name> <commandOrUrl> [rest...]')
    .description('Add a downstream MCP server to the configuration')
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .option('--transport <type>', 'transport type (stdio or http)', 'stdio')
    .option('--header <header>', 'HTTP header (Key: Value)', collectHeaders, {})
    .option('-e, --env <env>', 'environment variable (KEY=value)', collectEnv, {})
    .option(
      '--description <text>',
      'short (1-2 sentences) server description shown to the model; required',
    )
    .option('--enabled', 'mark the server as enabled (default; writes no field)')
    .option('--disabled', 'mark the server as disabled (writes "enabled": false)')
    .option(
      '--allowed-tools <pattern>',
      'glob pattern allowlisting tool names (repeatable)',
      collectStringArray,
      [],
    )
    .option(
      '--disabled-tools <pattern>',
      'glob pattern denylisting tool names (repeatable)',
      collectStringArray,
      [],
    )
    .option(
      '-p, --port <number>',
      'fixed local OAuth callback port (HTTP only; written to oauth.callbackPort)',
      parsePort,
    )
    .option(
      '--client-name <name>',
      'dynamic client registration client_name (HTTP only; written to oauth.clientName)',
      parseClientName,
    )
    .option(
      '--client-uri <uri>',
      'dynamic client registration client_uri (HTTP only; written to oauth.clientUri)',
      parseClientUri,
    )
    .option(
      '--no-browser',
      'print the authorization URL and paste the redirect URL or code instead of opening a browser',
    )
    .action(guardedAction(runAddCommand));
}

function registerRemoveCommand(program: Command): void {
  program
    .command('remove <name>')
    .description('Remove a downstream MCP server from the configuration')
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .action(
      guardedAction(async (name, options) => {
        const configPath = await resolveConfigPath(options.config);
        return handleRemove(configPath, name);
      }),
    );
}

function registerGetCommand(program: Command): void {
  program
    .command('get <name>')
    .description('Show details for a configured downstream MCP server')
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .action(
      guardedAction(async (name, options) => {
        const configPath = await resolveConfigPath(options.config);
        return handleGet(configPath, name);
      }),
    );
}

function registerListCommand(program: Command): void {
  program
    .command('list')
    .description('List all configured downstream MCP servers')
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .action(
      guardedAction(async (options) => {
        const configPath = await resolveConfigPath(options.config);
        return handleList(configPath);
      }),
    );
}

function registerLoginCommand(program: Command): void {
  program
    .command('login <name>')
    .description('Authenticate a downstream server using OAuth')
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .option(
      '-p, --port <number>',
      'fixed local OAuth callback port (overrides oauth.callbackPort; 0 = OS-assigned)',
      parsePort,
    )
    .option(
      '--client-name <name>',
      'override the dynamic client registration client_name for this login',
      parseClientName,
    )
    .option(
      '--client-uri <uri>',
      'override the dynamic client registration client_uri for this login',
      parseClientUri,
    )
    .option(
      '--no-browser',
      'print the authorization URL and paste the redirect URL or code instead of opening a browser',
    )
    .action(
      guardedAction(async (name, options: LoginCommandOptions) => {
        const configPath = await resolveConfigPath(options.config);
        const loginOptions: LoginOptions = {
          portOverride: options.port,
          clientNameOverride: options.clientName,
          clientUriOverride: options.clientUri,
          noBrowser: options.browser === false,
        };
        return handleLogin(configPath, name, loginOptions);
      }),
    );
}

function registerLogoutCommand(program: Command): void {
  program
    .command('logout <name>')
    .description('Revoke and remove OAuth credentials for a downstream server')
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .action(
      guardedAction(async (name, options) => {
        const configPath = await resolveConfigPath(options.config);
        return handleLogout(configPath, name);
      }),
    );
}

function registerEnableCommand(program: Command): void {
  program
    .command('enable <name>')
    .description('Enable a disabled downstream MCP server (removes the enabled field)')
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .action(
      guardedAction(async (name, options) => {
        const configPath = await resolveConfigPath(options.config);
        return handleEnable(configPath, name);
      }),
    );
}

function registerDisableCommand(program: Command): void {
  program
    .command('disable <name>')
    .description('Disable a downstream MCP server without removing its configuration')
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .action(
      guardedAction(async (name, options) => {
        const configPath = await resolveConfigPath(options.config);
        return handleDisable(configPath, name);
      }),
    );
}

function registerToolsCommand(program: Command): void {
  program
    .command('tools <name>')
    .description(
      'Connect to a downstream server live and list its tools with [exposed]/[filtered] markers',
    )
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .action(
      guardedAction(async (name, options) => {
        const configPath = await resolveConfigPath(options.config);
        return handleTools(configPath, name);
      }),
    );
}

function registerRouterCommand(program: Command): void {
  program
    .option('-c, --config <path>', 'path to mcp.json configuration file')
    .option('-v, --verbose', 'enable debug-level logging to stderr')
    .action(async (options) => {
      const verbose = options.verbose || process.env.MCP_COMPRESS_ROUTER_VERBOSE === 'true';
      await runRouter(options.config, verbose);
    });
}

/**
 * Registers every CLI subcommand (and the default router action) on the
 * given commander program.
 */
export function registerAllCommands(program: Command): void {
  registerAddCommand(program);
  registerRemoveCommand(program);
  registerGetCommand(program);
  registerListCommand(program);
  registerLoginCommand(program);
  registerLogoutCommand(program);
  registerEnableCommand(program);
  registerDisableCommand(program);
  registerToolsCommand(program);
  registerRouterCommand(program);
}
