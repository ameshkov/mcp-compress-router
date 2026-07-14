import { describe, it, expect, vi } from 'vitest';
import { invokeWithRecovery, isRecoverable } from './invoke-with-recovery.js';
import type { ServerConnection, InvokeResult } from './server-connection.js';
import type { ServerStatus, ToolCatalog, ToolSelection } from '../utils/index.js';
import { Logger } from '../utils/index.js';
import { GuidedAuthError } from './index.js';

function makeCatalog(): ToolCatalog {
  return {
    servers: [
      {
        name: 'srv',
        compressionLevel: 'high' as const,
        status: 'ok' as const,
        tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
      },
    ],
    toolMap: new Map([['srv::echo', { name: 'echo', inputSchema: { type: 'object' } }]]),
    filteredToolNames: new Set(),
  };
}

function makeMockConn(overrides?: Partial<ServerConnection>): ServerConnection {
  return {
    status: 'ok',
    lastError: undefined,
    lastReconnectAt: 0,
    cooldownElapsed: true,
    serverName: 'srv',
    serverConfig: {
      name: 'srv',
      type: 'http',
      url: 'https://example.com/mcp',
    },
    reconnect: vi.fn().mockResolvedValue({
      name: 'srv',
      tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
      status: 'ok',
    }),
    awaitReconnectInFlight: vi.fn().mockResolvedValue(undefined),
    refreshTokens: vi.fn(),
    invokeTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'result' }],
      isError: false,
    } as InvokeResult),
    close: vi.fn(),
    ...overrides,
  } as unknown as ServerConnection;
}

describe('invokeWithRecovery — OK server', () => {
  it('invokes the tool and returns the result', async () => {
    const catalog = makeCatalog();
    const conn = makeMockConn();
    const connections = new Map([['srv', conn]]);

    const result = await invokeWithRecovery(
      'srv',
      'echo',
      {},
      catalog,
      connections,
      new Map<string, ToolSelection>(),
      new Logger('error'),
    );

    expect(result.content).toHaveLength(1);
    expect(conn.reconnect).not.toHaveBeenCalled();
    expect(conn.refreshTokens).toHaveBeenCalled();
    expect(conn.invokeTool).toHaveBeenCalledWith('echo', {});
  });

  it('retries once on a recoverable runtime failure', async () => {
    const catalog = makeCatalog();
    const conn = makeMockConn({
      invokeTool: vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'retried' }],
          isError: false,
        } as InvokeResult),
    } as Partial<ServerConnection>);
    const connections = new Map([['srv', conn]]);

    const result = await invokeWithRecovery(
      'srv',
      'echo',
      {},
      catalog,
      connections,
      new Map<string, ToolSelection>(),
      new Logger('error'),
    );

    expect(conn.reconnect).toHaveBeenCalledTimes(1);
    expect(conn.invokeTool).toHaveBeenCalledTimes(2);
    expect(result.content[0]).toMatchObject({ text: 'retried' });
  });

  it('throws guided error when retry also fails', async () => {
    const catalog = makeCatalog();
    const conn = makeMockConn({
      invokeTool: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
      reconnect: vi.fn().mockRejectedValue(new Error('still down')),
    } as Partial<ServerConnection>);
    const connections = new Map([['srv', conn]]);

    await expect(
      invokeWithRecovery(
        'srv',
        'echo',
        {},
        catalog,
        connections,
        new Map<string, ToolSelection>(),
        new Logger('error'),
      ),
    ).rejects.toThrow(/unavailable/);
  });

  it('reports an auth failure (not unavailable) when retry fails with GuidedAuthError', async () => {
    const catalog = makeCatalog();
    const authErr = new GuidedAuthError('srv');
    const conn = makeMockConn({
      invokeTool: vi.fn().mockRejectedValue(authErr),
      reconnect: vi.fn().mockRejectedValue(authErr),
    } as Partial<ServerConnection>);
    const connections = new Map([['srv', conn]]);

    await expect(
      invokeWithRecovery(
        'srv',
        'echo',
        {},
        catalog,
        connections,
        new Map<string, ToolSelection>(),
        new Logger('error'),
      ),
    ).rejects.toThrow(/authentication is required/);
  });

  it('reports an auth failure when retry fails with a raw invalid_token error', async () => {
    const catalog = makeCatalog();
    const authErr = new Error(
      'Streamable HTTP error: Error POSTing to endpoint: ' +
        '{"error":"invalid_token","error_description":"Missing or invalid access token"}',
    );
    const conn = makeMockConn({
      invokeTool: vi.fn().mockRejectedValue(authErr),
      reconnect: vi.fn().mockRejectedValue(authErr),
    } as Partial<ServerConnection>);
    const connections = new Map([['srv', conn]]);

    await expect(
      invokeWithRecovery(
        'srv',
        'echo',
        {},
        catalog,
        connections,
        new Map<string, ToolSelection>(),
        new Logger('error'),
      ),
    ).rejects.toThrow(/authentication is required/);
  });

  it('reports auth failure when reconnect succeeds but retried invoke fails with GuidedAuthError', async () => {
    const catalog = makeCatalog();
    const conn = makeMockConn({
      invokeTool: vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new GuidedAuthError('srv')),
      reconnect: vi.fn().mockResolvedValue({
        name: 'srv',
        tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
        status: 'ok',
      }),
    } as Partial<ServerConnection>);
    const connections = new Map([['srv', conn]]);

    await expect(
      invokeWithRecovery(
        'srv',
        'echo',
        {},
        catalog,
        connections,
        new Map<string, ToolSelection>(),
        new Logger('error'),
      ),
    ).rejects.toThrow(/authentication is required/);
  });

  it('re-throws original error when reconnect succeeds but retried invoke fails with non-auth error', async () => {
    const catalog = makeCatalog();
    const conn = makeMockConn({
      invokeTool: vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('Method not found')),
      reconnect: vi.fn().mockResolvedValue({
        name: 'srv',
        tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
        status: 'ok',
      }),
    } as Partial<ServerConnection>);
    const connections = new Map([['srv', conn]]);

    await expect(
      invokeWithRecovery(
        'srv',
        'echo',
        {},
        catalog,
        connections,
        new Map<string, ToolSelection>(),
        new Logger('error'),
      ),
    ).rejects.toThrow('Method not found');
  });

  it('does not retry on non-recoverable errors', async () => {
    const catalog = makeCatalog();
    const nonRecoverable = new Error('Method not found');
    const conn = makeMockConn({
      invokeTool: vi.fn().mockRejectedValue(nonRecoverable),
    } as Partial<ServerConnection>);
    const connections = new Map([['srv', conn]]);

    await expect(
      invokeWithRecovery(
        'srv',
        'echo',
        {},
        catalog,
        connections,
        new Map<string, ToolSelection>(),
        new Logger('error'),
      ),
    ).rejects.toThrow('Method not found');

    expect(conn.reconnect).not.toHaveBeenCalled();
  });
});

describe('invokeWithRecovery — degraded server', () => {
  it('attempts self-recovery when status is unauthorized', async () => {
    const catalog = {
      ...makeCatalog(),
      servers: [{ ...makeCatalog().servers[0], status: 'unauthorized' as const }],
    };
    const conn = makeMockConn({
      status: 'unauthorized',
    } as Partial<ServerConnection>);
    const connections = new Map([['srv', conn]]);

    const _result = await invokeWithRecovery(
      'srv',
      'echo',
      {},
      catalog,
      connections,
      new Map<string, ToolSelection>(),
      new Logger('error'),
    );

    expect(conn.reconnect).toHaveBeenCalledTimes(1);
    expect(conn.invokeTool).toHaveBeenCalledWith('echo', {});
    expect(catalog.servers[0].status).toBe('ok');
  });

  it('returns cached guided error within cooldown window', async () => {
    const catalog = {
      ...makeCatalog(),
      servers: [{ ...makeCatalog().servers[0], status: 'unavailable' as const }],
    };
    const conn = makeMockConn({
      status: 'unavailable',
      lastError: 'ECONNREFUSED',
      lastReconnectAt: Date.now(),
      cooldownElapsed: false,
    } as Partial<ServerConnection>);
    const connections = new Map([['srv', conn]]);

    await expect(
      invokeWithRecovery(
        'srv',
        'echo',
        {},
        catalog,
        connections,
        new Map<string, ToolSelection>(),
        new Logger('error'),
      ),
    ).rejects.toThrow(/unavailable/);

    expect(conn.reconnect).not.toHaveBeenCalled();
  });

  it('coalesces with an in-flight reconnect instead of short-circuiting on cooldown', async () => {
    // Server is degraded AND within the cooldown window, BUT a reconnect
    // is already in flight and about to succeed. Without the fix this call
    // would short-circuit on cooldown and throw a stale guided error;
    // instead it must join the in-flight reconnect and proceed to invoke.
    const catalog = {
      ...makeCatalog(),
      servers: [{ ...makeCatalog().servers[0], status: 'unavailable' as const }],
    };

    let status: ServerStatus = 'unavailable';
    const inFlightData = {
      name: 'srv',
      tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
      status: 'ok' as const,
    };
    const awaitReconnectInFlight = vi.fn().mockImplementation(async () => {
      // Real doReconnect transitions the connection to 'ok' on success.
      status = 'ok';
      return inFlightData;
    });
    const conn = {
      get status(): ServerStatus {
        return status;
      },
      lastError: 'ECONNREFUSED',
      lastReconnectAt: Date.now(),
      get cooldownElapsed(): boolean {
        return false; // would short-circuit without the coalescing fix
      },
      serverName: 'srv',
      serverConfig: {
        name: 'srv',
        type: 'http',
        url: 'https://example.com/mcp',
      },
      reconnect: vi.fn(), // must NOT be called — the in-flight one is reused
      awaitReconnectInFlight,
      refreshTokens: vi.fn(),
      invokeTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'recovered' }],
        isError: false,
      } as InvokeResult),
      close: vi.fn(),
    } as unknown as ServerConnection;
    const connections = new Map([['srv', conn]]);

    const result = await invokeWithRecovery(
      'srv',
      'echo',
      {},
      catalog,
      connections,
      new Map<string, ToolSelection>(),
      new Logger('error'),
    );

    expect(awaitReconnectInFlight).toHaveBeenCalledTimes(1);
    expect(conn.reconnect).not.toHaveBeenCalled();
    expect(catalog.servers[0].status).toBe('ok');
    expect(conn.invokeTool).toHaveBeenCalledWith('echo', {});
    expect(result.content[0]).toMatchObject({ text: 'recovered' });
  });

  it('throws guided error when recovery fails', async () => {
    const catalog = {
      ...makeCatalog(),
      servers: [{ ...makeCatalog().servers[0], status: 'unauthorized' as const }],
    };
    const conn = makeMockConn({
      status: 'unauthorized',
      reconnect: vi.fn().mockRejectedValue(new GuidedAuthError('srv')),
    } as Partial<ServerConnection>);
    const connections = new Map([['srv', conn]]);

    await expect(
      invokeWithRecovery(
        'srv',
        'echo',
        {},
        catalog,
        connections,
        new Map<string, ToolSelection>(),
        new Logger('error'),
      ),
    ).rejects.toThrow();
  });
});

describe('isRecoverable', () => {
  it('returns true for GuidedAuthError', () => {
    expect(isRecoverable(new GuidedAuthError('srv'))).toBe(true);
  });

  it('returns true for a raw invalid_token auth error', () => {
    expect(
      isRecoverable(
        new Error(
          'Streamable HTTP error: Error POSTing to endpoint: ' +
            '{"error":"invalid_token","error_description":"Missing or invalid access token"}',
        ),
      ),
    ).toBe(true);
  });

  it('returns true for ECONNRESET', () => {
    expect(isRecoverable(new Error('ECONNRESET'))).toBe(true);
  });

  it('returns true for ECONNREFUSED', () => {
    expect(isRecoverable(new Error('ECONNREFUSED'))).toBe(true);
  });

  it('returns true for ETIMEDOUT', () => {
    expect(isRecoverable(new Error('ETIMEDOUT'))).toBe(true);
  });

  it('returns false for "Method not found"', () => {
    expect(isRecoverable(new Error('Method not found'))).toBe(false);
  });

  it('returns false for "Invalid arguments"', () => {
    expect(isRecoverable(new Error('Invalid arguments: missing required field'))).toBe(false);
  });
});
