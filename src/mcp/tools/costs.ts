/**
 * MCP Cost Reporting Tool - Token usage and API costs
 *
 * Reports costs from radl-ops internal Claude API calls
 * (eval-opt loops, social drafts, etc.), not Claude Code's own usage.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getTodaySummary, getCostSummaryForBriefing, checkCostThreshold } from '../../models/token-tracker.js';
import { withErrorTracking } from '../with-error-tracking.js';

export function registerCostTools(server: McpServer): void {
  server.tool(
    'cost_report',
    'Get API cost summary for radl-ops internal Claude API usage (briefing eval-opt loops, social drafts, etc.)',
    {
      format: z.enum(['summary', 'detailed']).optional().default('summary')
        .describe('Output format: summary (text) or detailed (JSON breakdown)'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    withErrorTracking('cost_report', async ({ format }) => {
      const alert = checkCostThreshold();
      const analytics = getTodaySummary();
      const alertLine = alert.level !== 'ok'
        ? `\n\n**${alert.level.toUpperCase()}**: ${alert.message}`
        : '';

      if (format === 'summary') {
        const text = getCostSummaryForBriefing();
        return { content: [{ type: 'text' as const, text: text + alertLine }] };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...analytics,
            cache: {
              readTokens: analytics.totalCacheReadTokens,
              writeTokens: analytics.totalCacheWriteTokens,
              estimatedSavingsUsd: analytics.estimatedCacheSavingsUsd,
            },
            alert,
          }, null, 2),
        }],
      };
    })
  );
}
