#!/usr/bin/env node
/**
 * Router protocol probe for the manual QA stack.
 *
 * Spawns `build/index.js` over stdio, performs the MCP initialize
 * handshake against the QA router home (qa/home), and runs exactly one
 * request:
 *
 *   pnpm qa:probe --list
 *   pnpm qa:probe --tool get_tool_schema \
 *     --args '{"server":"stdio-mock","tools":["add"]}'
 *   pnpm qa:probe --tool invoke_tool \
 *     --args '{"server":"stdio-mock","tool":"echo","arguments":{"message":"hi"}}'
 *
 * Run `pnpm qa:setup` and add a downstream server first (see
 * qa/README.md). The process exits 0 when the request completed (a
 * tool-level `isError` result still counts as completed) and 1 on a
 * transport failure, protocol error, or timeout.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTER_ENTRY = resolve(REPO_ROOT, 'build', 'index.js');
const DEFAULT_HOME = resolve(REPO_ROOT, 'qa', 'home');
const DEFAULT_TIMEOUT_MS = 20_000;

/** A JSON-RPC message exchanged with the router over stdio. */
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** A spawned router process with a pending-request map. */
class RouterProbe {
  private readonly pending = new Map<number, (message: JsonRpcMessage) => void>();
  private nextId = 1;
  private stderr = '';

  private constructor(
    private readonly proc: ChildProcess,
    private readonly rl: Interface,
  ) {}

  /**
   * Spawns the router and completes the MCP initialize handshake.
   *
   * @param home - Value for `MCP_COMPRESS_ROUTER_HOME`.
   * @param configPath - Explicit `--config` path, or undefined for the
   *   home's default config file.
   * @param verbose - Forward `--verbose` to the router.
   * @returns A ready probe.
   */
  static async start(
    home: string,
    configPath: string | undefined,
    verbose: boolean,
  ): Promise<RouterProbe> {
    const args = [ROUTER_ENTRY];
    if (configPath !== undefined) {
      args.push('--config', configPath);
    }
    if (verbose) {
      args.push('--verbose');
    }
    const proc = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MCP_COMPRESS_ROUTER_HOME: home },
    });
    const rl = createInterface({ input: proc.stdout! });
    const probe = new RouterProbe(proc, rl);
    rl.on('line', (line) => probe.handleLine(line));
    proc.stderr?.on('data', (chunk: Buffer) => {
      probe.stderr += chunk.toString();
    });
    proc.once('exit', (code, signal) => {
      probe.failAllPending(new Error(`router exited (code ${code}, signal ${signal})`));
    });
    await probe.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'qa-probe', version: '1.0.0' },
    });
    probe.notify('notifications/initialized');
    return probe;
  }

  /**
   * Routes one stdout line to the pending request with the same id.
   *
   * @param line - A raw stdout line.
   */
  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') {
      return;
    }
    const resolvePending = this.pending.get(message.id);
    if (resolvePending) {
      this.pending.delete(message.id);
      resolvePending(message);
    }
  }

  /**
   * Sends a JSON-RPC notification (no response expected).
   *
   * @param method - The JSON-RPC method.
   * @param params - Optional parameters.
   */
  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /**
   * Sends a JSON-RPC request and resolves with the matching response.
   *
   * @param method - The JSON-RPC method.
   * @param params - Request parameters.
   * @param timeoutMs - How long to wait before rejecting.
   * @returns The response message.
   */
  request(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    this.write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`timed out after ${timeoutMs} ms waiting for ${method}${this.stderrTail()}`),
        );
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolvePromise(message);
      });
    });
  }

  /**
   * Writes a message to the router's stdin.
   *
   * @param message - The message to send.
   */
  private write(message: JsonRpcMessage): void {
    this.proc.stdin!.write(JSON.stringify(message) + '\n');
  }

  /**
   * Rejects every pending request (used when the router exits).
   *
   * @param error - The error to reject with.
   */
  private failAllPending(error: Error): void {
    for (const resolvePending of this.pending.values()) {
      resolvePending({ error: { message: error.message } });
    }
    this.pending.clear();
  }

  /**
   * Returns the last router stderr lines for error messages.
   *
   * @returns A formatted stderr tail, or an empty string.
   */
  private stderrTail(): string {
    const trimmed = this.stderr.trim();
    return trimmed === '' ? '' : `\nRouter stderr:\n${trimmed.slice(-2000)}`;
  }

  /**
   * Ends stdin for a clean shutdown and force-kills after 5 seconds.
   */
  async close(): Promise<void> {
    this.rl.close();
    this.proc.stdin?.end();
    await new Promise<void>((resolvePromise) => {
      if (this.proc.exitCode !== null) {
        resolvePromise();
        return;
      }
      const timer = setTimeout(() => {
        this.proc.kill('SIGKILL');
        resolvePromise();
      }, 5000);
      this.proc.once('close', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }

  /**
   * Returns everything the router wrote to stderr.
   *
   * @returns The captured stderr text.
   */
  getStderr(): string {
    return this.stderr;
  }
}

const { values } = parseArgs({
  options: {
    list: { type: 'boolean', default: false },
    tool: { type: 'string' },
    args: { type: 'string' },
    config: { type: 'string' },
    home: { type: 'string' },
    timeout: { type: 'string' },
    verbose: { type: 'boolean', default: false },
  },
});

/**
 * Parses and validates the `--timeout` value.
 *
 * @param raw - The raw option value.
 * @returns The timeout in milliseconds.
 */
function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid --timeout: ${raw}`);
  }
  return value;
}

/**
 * Parses and validates the `--args` JSON object.
 *
 * @param raw - The raw option value.
 * @returns The parsed arguments object.
 */
function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--args must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Prints the `tools/list` result in a readable form.
 *
 * @param response - The JSON-RPC response.
 * @returns Process exit code.
 */
function printToolsResponse(response: JsonRpcMessage): number {
  if (response.error) {
    console.error(`JSON-RPC error: ${JSON.stringify(response.error, null, 2)}`);
    return 1;
  }
  const result = response.result as
    { tools?: Array<{ name: string; description?: string }> } | undefined;
  const tools = result?.tools ?? [];
  console.log(`Tools exposed by the router (${tools.length}):\n`);
  for (const tool of tools) {
    console.log(tool.name);
    for (const line of (tool.description ?? '').split('\n')) {
      console.log(`  ${line}`);
    }
    console.log('');
  }
  return 0;
}

/**
 * Prints a `tools/call` result as pretty JSON.
 *
 * @param toolName - The router tool that was called.
 * @param response - The JSON-RPC response.
 * @returns Process exit code.
 */
function printToolResponse(toolName: string, response: JsonRpcMessage): number {
  if (response.error) {
    console.error(`JSON-RPC error: ${JSON.stringify(response.error, null, 2)}`);
    return 1;
  }
  console.log(`Result of ${toolName}:`);
  console.log(JSON.stringify(response.result, null, 2));
  return 0;
}

/**
 * Runs the probe: validates options, performs the request, closes.
 *
 * @returns Process exit code.
 */
async function main(): Promise<number> {
  if (!existsSync(ROUTER_ENTRY)) {
    console.error(`Router build not found: ${ROUTER_ENTRY}\nRun "pnpm build" first.`);
    return 1;
  }
  if (!values.list && !values.tool) {
    console.error('Nothing to do: pass --list or --tool <name> (see the header comment).');
    return 2;
  }
  const home = values.home ?? DEFAULT_HOME;
  const timeoutMs = parseTimeout(values.timeout);
  const probe = await RouterProbe.start(home, values.config, values.verbose);
  try {
    if (values.list) {
      return printToolsResponse(await probe.request('tools/list', {}, timeoutMs));
    }
    const toolArgs = parseToolArgs(values.args);
    const response = await probe.request(
      'tools/call',
      { name: values.tool, arguments: toolArgs },
      timeoutMs,
    );
    return printToolResponse(values.tool as string, response);
  } finally {
    if (values.verbose) {
      process.stderr.write(probe.getStderr());
    }
    await probe.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
