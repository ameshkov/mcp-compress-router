import { spawn, ChildProcess } from 'node:child_process';
import { createInterface, Interface } from 'node:readline';

/**
 * JSON-RPC message exchanged between test client and router.
 *
 * @internal — exported for E2E test files only; not part of the public
 *   module API.
 */
export interface JsonRpcMessage {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: unknown;
  params?: unknown;
}

/**
 * A lightweight MCP JSON-RPC test client that communicates with a
 * subprocess over stdio. Handles MCP initialization handshake
 * automatically.
 *
 * @internal — exported for E2E test files only; not part of the public
 *   module API.
 */
export class McpTestClient {
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

  /** Check if the underlying process is still running. */
  isAlive(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
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
