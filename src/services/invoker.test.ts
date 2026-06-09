import { describe, it, expect, vi } from 'vitest';
import { invokeDownstreamTool } from './invoker.js';
import { Logger } from '../utils/index.js';

function createMockClient(callToolImpl: (params: unknown) => unknown) {
  return {
    callTool: vi.fn().mockImplementation(callToolImpl),
  } as unknown as Parameters<typeof invokeDownstreamTool>[0] extends Map<string, infer C>
    ? C
    : never;
}

describe('invokeDownstreamTool', () => {
  it('forwards the call to the correct client and returns result verbatim', async () => {
    const downstreamResult = {
      content: [{ type: 'text' as const, text: 'hello from downstream' }],
    };

    const mockClient = createMockClient(async (params) => {
      expect(params).toEqual({
        name: 'my_tool',
        arguments: { key: 'value' },
      });
      return downstreamResult;
    });

    const clients = new Map([['srv', mockClient]]);

    const result = await invokeDownstreamTool(
      clients,
      'srv',
      'my_tool',
      { key: 'value' },
      new Logger('error'),
    );

    expect(result).toBe(downstreamResult);
    expect(mockClient.callTool).toHaveBeenCalledTimes(1);
  });

  it('passes multi-block content through unchanged in structure and order', async () => {
    const downstreamResult = {
      content: [
        { type: 'text' as const, text: 'First block' },
        { type: 'text' as const, text: 'Second block' },
        {
          type: 'resource' as const,
          resource: { uri: 'file:///test', text: 'resource content' },
        },
      ],
    };

    const mockClient = createMockClient(async () => downstreamResult);
    const clients = new Map([['srv', mockClient]]);

    const result = await invokeDownstreamTool(
      clients,
      'srv',
      'multi_return',
      {},
      new Logger('error'),
    );

    expect(result.content).toHaveLength(3);
    expect(result.content[0]).toEqual(downstreamResult.content[0]);
    expect(result.content[1]).toEqual(downstreamResult.content[1]);
    expect(result.content[2]).toEqual(downstreamResult.content[2]);
  });

  it('resolves server-scoped identity: routes to the correct server when two servers share a tool name', async () => {
    const clientA = createMockClient(async (params) => {
      expect(params).toEqual({ name: 'shared_tool', arguments: {} });
      return { content: [{ type: 'text' as const, text: 'from A' }] };
    });
    const clientB = createMockClient(async (params) => {
      expect(params).toEqual({ name: 'shared_tool', arguments: {} });
      return { content: [{ type: 'text' as const, text: 'from B' }] };
    });

    const clients = new Map([
      ['server_a', clientA],
      ['server_b', clientB],
    ]);

    const resultA = await invokeDownstreamTool(
      clients,
      'server_a',
      'shared_tool',
      {},
      new Logger('error'),
    );
    const resultB = await invokeDownstreamTool(
      clients,
      'server_b',
      'shared_tool',
      {},
      new Logger('error'),
    );

    expect(resultA.content[0].text).toBe('from A');
    expect(resultB.content[0].text).toBe('from B');
    expect(clientA.callTool).toHaveBeenCalledTimes(1);
    expect(clientB.callTool).toHaveBeenCalledTimes(1);
  });

  it('passes through isError: true from downstream tool verbatim', async () => {
    const downstreamResult = {
      content: [{ type: 'text' as const, text: 'Something went wrong downstream' }],
      isError: true as const,
    };

    const mockClient = createMockClient(async () => downstreamResult);
    const clients = new Map([['srv', mockClient]]);

    const result = await invokeDownstreamTool(
      clients,
      'srv',
      'failing_tool',
      {},
      new Logger('error'),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual(downstreamResult.content);
  });

  it('throws when callTool rejects (transport failure)', async () => {
    const mockClient = createMockClient(async () => {
      throw new Error('Transport closed');
    });
    const clients = new Map([['srv', mockClient]]);

    await expect(
      invokeDownstreamTool(clients, 'srv', 'echo', {}, new Logger('error')),
    ).rejects.toThrow('Transport closed');
  });

  it('surfaces guided login error on auth failure', async () => {
    const mockClient = createMockClient(async () => {
      throw new Error('Unauthorized: token expired');
    });
    const clients = new Map([['github', mockClient]]);

    await expect(
      invokeDownstreamTool(clients, 'github', 'list_repos', {}, new Logger('error')),
    ).rejects.toThrow('login github');
  });

  it('passes through generic errors unchanged', async () => {
    const mockClient = createMockClient(async () => {
      throw new Error('Internal server error');
    });
    const clients = new Map([['srv', mockClient]]);

    await expect(
      invokeDownstreamTool(clients, 'srv', 'echo', {}, new Logger('error')),
    ).rejects.toThrow('Internal server error');
  });
});
