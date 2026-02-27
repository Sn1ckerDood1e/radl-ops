/**
 * RAPTOR Summaries MCP Tool
 *
 * Exposes RAPTOR hierarchical knowledge summaries as an MCP tool.
 * - raptor_summarize: Rebuild or view RAPTOR summaries (~$0.005 via Haiku)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorTracking } from '../with-error-tracking.js';
import {
  buildRaptorSummaries,
  getRaptorSummaries,
  isSummaryStale,
  formatRaptorReport,
} from '../../knowledge/raptor.js';

export function registerRaptorSummaryTools(server: McpServer): void {
  server.tool(
    'raptor_summarize',
    'Build or view RAPTOR hierarchical knowledge summaries. Clusters knowledge entries by domain and generates multi-level AI summaries. Use action "view" for cached results (zero cost) or "rebuild" to regenerate (~$0.005 via Haiku).',
    {
      action: z.enum(['view', 'rebuild']).default('view')
        .describe('Action: "view" shows cached summaries, "rebuild" regenerates from knowledge base'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    withErrorTracking('raptor_summarize', async ({ action }) => {
      if (action === 'view') {
        const cached = getRaptorSummaries();
        if (!cached) {
          const stale = isSummaryStale();
          return {
            content: [{
              type: 'text' as const,
              text: stale
                ? 'No RAPTOR summaries found. Run with action: "rebuild" to generate.'
                : 'No RAPTOR summaries available.',
            }],
          };
        }

        const report = formatRaptorReport(cached);
        const staleNote = isSummaryStale()
          ? '\n\n*Summaries are stale (>7 days old). Consider rebuilding.*'
          : '';

        return {
          content: [{ type: 'text' as const, text: report + staleNote }],
        };
      }

      // Rebuild
      const summaries = await buildRaptorSummaries();
      const report = formatRaptorReport(summaries);

      return {
        content: [{
          type: 'text' as const,
          text: `${report}\n\n*Rebuilt successfully. Cost: $${summaries.costUsd.toFixed(4)}*`,
        }],
      };
    }),
  );
}
