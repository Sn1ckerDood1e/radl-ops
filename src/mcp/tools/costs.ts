/**
 * MCP Cost Reporting Tool - Token usage and API costs
 *
 * Reports costs from radl-ops internal Claude API calls
 * (eval-opt loops, social drafts, etc.), not Claude Code's own usage.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getTodaySummary, getCostSummaryForBriefing, checkCostThreshold, getCurrentSprintPhase } from '../../models/token-tracker.js';
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

      const structured = {
        ...analytics,
        cache: {
          readTokens: analytics.totalCacheReadTokens,
          writeTokens: analytics.totalCacheWriteTokens,
          estimatedSavingsUsd: analytics.estimatedCacheSavingsUsd,
        },
        activeSprint: getCurrentSprintPhase(),
        alert,
      };

      if (format === 'summary') {
        let text = getCostSummaryForBriefing();

        // Add sprint cost breakdown if available
        const sprintEntries = Object.entries(analytics.bySprint).filter(([k]) => k !== 'untagged');
        if (sprintEntries.length > 0) {
          text += '\n\n**By Sprint:**';
          for (const [sprint, data] of sprintEntries) {
            text += `\n- ${sprint}: ${data.calls} calls, $${data.costUsd.toFixed(4)}`;
          }
        }

        const currentPhase = getCurrentSprintPhase();
        if (currentPhase) {
          text += `\n\n_Active sprint: ${currentPhase}_`;
        }

        return {
          content: [{ type: 'text' as const, text: text + alertLine }],
          structuredContent: structured,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(structured, null, 2),
        }],
        structuredContent: structured,
      };
    })
  );
}
