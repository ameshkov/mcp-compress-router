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
} from './index.js';
import { runRouter } from './router-runner.js';

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

/**
 * Collects repeated `--flag <value>` flags into an ordered string array.
 * @internal — Exported for tests only; not part of the public module API.
 */
export function collectStringArray(value: string, previous: string[]): string[] {
  return [...previous, value];
}

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
  };
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
      'server description exposed to the LLM to help it route requests',
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
    .action(
      guardedAction(async (name, commandOrUrl, rest, options: AddCommandOptions) => {
        const configPath = await resolveConfigPath(options.config);
        return handleAdd(configPath, buildAddOptions(name, commandOrUrl, rest, options));
      }),
    );
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
    .action(
      guardedAction(async (name, options) => {
        const configPath = await resolveConfigPath(options.config);
        return handleLogin(configPath, name);
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
