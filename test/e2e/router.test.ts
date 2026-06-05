import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createInterface, Interface } from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, '..', 'fixture-server.ts');
const routerPath = path.resolve(__dirname, '..', '..', 'build', 'index.js');

async function nodeExists(cmd: string): Promise<boolean> {
  try {
    await fs.access(cmd);
    return true;
  } catch {
    return false;
  }
}

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: unknown;
  params?: unknown;
}

class McpTestClient {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private messageQueue: JsonRpcMessage[] = [];
  private waiters: Array<{ resolve: (m: JsonRpcMessage) => void }> = [];
  private nextId = 1;
  private stdErr = '';

  async start(command: string, args: string[], env?: Record<string, string>) {
    this.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      this.stdErr += chunk.toString();
    });

    this.rl = createInterface({ input: this.proc.stdout! });

    this.rl.on('line', (line: string) => {
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter.resolve(msg);
        } else {
          this.messageQueue.push(msg);
        }
      } catch {
        // ignore non-JSON lines
      }
    });

    // Send initialize
    const initResp = await this.sendRequest('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    if (initResp.error) {
      throw new Error(`Initialize failed: ${JSON.stringify(initResp.error)}`);
    }

    // Send initialized notification
    this.sendNotification('notifications/initialized');
  }

  private sendMessage(msg: JsonRpcMessage) {
    this.proc!.stdin!.write(JSON.stringify(msg) + '\n');
  }

  sendNotification(method: string, params?: unknown) {
    this.sendMessage({ jsonrpc: '2.0', method, params });
  }

  async sendRequest(method: string, params?: unknown): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    this.sendMessage({ jsonrpc: '2.0', id, method, params });

    return new Promise((resolve) => {
      this.waiters.push({ resolve });
    });
  }

  async close() {
    this.proc?.stdin?.end();
    this.proc?.kill();
    this.rl?.close();
    this.stdErr = '';
  }

  getStderr() {
    return this.stdErr;
  }
}

async function resolveFixtureCommand(): Promise<{
  command: string;
  args: string[];
}> {
  const tsxCommand = path.resolve('node_modules/.bin/tsx');
  if (await nodeExists(tsxCommand)) {
    return { command: tsxCommand, args: [fixturePath] };
  }
  return { command: 'node', args: [fixturePath.replace('.ts', '.js')] };
}

describe('MCP Compress Router E2E', () => {
  let client: McpTestClient;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(tmpdir(), `mcp-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });

    const fixture = await resolveFixtureCommand();

    const config = {
      mcpServers: {
        fixture: {
          type: 'stdio',
          command: fixture.command,
          args: fixture.args,
          description: 'A test fixture server',
        },
      },
    };

    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(configPath, JSON.stringify(config));

    client = new McpTestClient();
    await client.start('node', [routerPath, '--config', configPath], {
      MCP_COMPRESS_ROUTER_HOME: tempDir,
    });
  });

  afterEach(async () => {
    await client.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('exposes exactly get_tool_schema and invoke_tool', async () => {
    const resp = await client.sendRequest('tools/list');
    expect(resp.error).toBeUndefined();

    const tools = (resp.result as { tools: Array<{ name: string }> }).tools;
    expect(tools).toHaveLength(2);

    const toolNames = tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(['get_tool_schema', 'invoke_tool']);
  });

  it('get_tool_schema description contains server name and tool names', async () => {
    const resp = await client.sendRequest('tools/list');
    const tools = (
      resp.result as {
        tools: Array<{ name: string; description?: string }>;
      }
    ).tools;
    const gts = tools.find((t) => t.name === 'get_tool_schema')!;
    expect(gts.description).toContain('fixture');
    expect(gts.description).toContain('echo');
    expect(gts.description).toContain('add');
    expect(gts.description).toContain('A test fixture server');
  });

  it('get_tool_schema returns schema for a known tool', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'get_tool_schema',
      arguments: {
        server: 'fixture',
        tools: ['echo'],
      },
    });

    expect(resp.error).toBeUndefined();

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
    };
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe('echo');
    expect(parsed[0].description).toBe('Returns the input message unchanged.');
    expect(parsed[0].inputSchema).toHaveProperty('properties');
  });

  it('get_tool_schema returns error for unknown server', async () => {
    const resp = await client.sendRequest('tools/call', {
      name: 'get_tool_schema',
      arguments: {
        server: 'nonexistent',
        tools: ['echo'],
      },
    });

    const result = resp.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent');
    expect(result.content[0].text).toContain('fixture');
  });
});
