/**
 * Shared test utilities for MCP tool/resource/prompt tests
 *
 * Provides createMockServer() that captures handler registrations
 * regardless of argument count (handles annotations, descriptions, etc.).
 *
 * Pattern: handlers[name] = args[args.length - 1] (always the callback)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MockServer {
  tool: (...args: unknown[]) => void;
  resource: (...args: unknown[]) => void;
  prompt: (...args: unknown[]) => void;
}

/**
 * Create a mock MCP server that captures tool/resource/prompt handlers.
 * Returns the mock server and a handlers map.
 *
 * Usage:
 *   const { server, handlers } = createMockServer();
 *   registerXxxTools(server as any);
 *   const result = await handlers['tool_name']({ arg: 'value' });
 */
export function createMockServer(): {
  server: MockServer;
  handlers: Record<string, Function>;
} {
  const handlers: Record<string, Function> = {};

  const server: MockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
    resource: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
    prompt: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
  };

  return { server, handlers };
}
