import { z } from 'zod';

/**
 * Schema for invoke_tool parameters.
 */
export const InvokeToolInputSchema = {
  server: z.string().describe('The name of the MCP server that has the tool.'),
  tool: z.string().describe('The name of the tool to invoke.'),
  arguments: z.object({}).passthrough().describe('The arguments to pass to the tool.'),
};

/**
 * Creates a stub invoke_tool handler.
 *
 * Full implementation is deferred to Issue 2-AFK.
 *
 * @returns A handler function for the invoke_tool MCP tool.
 */
export function createInvokeToolHandler() {
  return async (_params: { server: string; tool: string; arguments: Record<string, unknown> }) => {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'TODO: invoke_tool not yet implemented',
        },
      ],
    };
  };
}
