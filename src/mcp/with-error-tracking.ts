/**
 * MCP Tool Error Tracking Wrapper
 *
 * Higher-order function that wraps MCP tool handlers with 3-strike
 * error tracking from iron-laws.ts. On success, strike count resets.
 * After 3 consecutive failures, returns escalation message.
 */

import { recordError, clearError } from '../guardrails/iron-laws.js';
import { logger } from '../config/logger.js';

/**
 * MCP tool handler return type — index signature required by MCP SDK
 */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Generic tool handler function matching MCP SDK signature.
 * The second arg (extra) is passed by the SDK but we pass it through.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler<T = Record<string, unknown>> = (params: T, extra?: any) => Promise<ToolResult>;

/**
 * Wrap an MCP tool handler with 3-strike error tracking.
 *
 * - On success: clears strike count for this tool
 * - On failure: increments strike count, returns error message
 * - After 3 failures: returns escalation message telling the agent to stop
 */
export function withErrorTracking<T>(
  toolName: string,
  handler: ToolHandler<T>
): ToolHandler<T> {
  return async (params: T, extra?: unknown): Promise<ToolResult> => {
    try {
      const result = await handler(params, extra);
      clearError(toolName);
      return result;
    } catch (error) {
      const count = recordError(toolName);
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Tool ${toolName} failed (strike ${count}/3)`, { error: msg });

      if (count >= 3) {
        return {
          content: [{
            type: 'text' as const,
            text: `**3-STRIKE LIMIT REACHED** for \`${toolName}\`\n\n` +
              `Failed ${count} times. Stopping to escalate.\n` +
              `Last error: ${msg}\n\n` +
              `Do NOT retry. Explain what failed and ask the user for guidance.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: `**ERROR** (strike ${count}/3): ${toolName} failed\n${msg}`,
        }],
        isError: true,
      };
    }
  };
}
