/**
 * MCP Trace Report Tool
 *
 * Surfaces span-level trace data from the observability layer.
 * Zero-cost for session spans (in-memory). Disk read for historical.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import {
  getSessionSpans,
  getSpansForDate,
  aggregateTraces,
  type TraceReport,
} from '../../observability/tracer.js';

function formatReport(report: TraceReport, scope: string): string {
  const lines: string[] = [
    `Trace Report (${scope})`,
    `Spans: ${report.spanCount} | Duration: ${(report.totalDurationMs / 1000).toFixed(1)}s | Errors: ${(report.errorRate * 100).toFixed(0)}%`,
    `Tokens: ${report.totalInputTokens} in / ${report.totalOutputTokens} out | Cache reads: ${report.totalCacheReadTokens} (${(report.cacheHitRate * 100).toFixed(0)}% hit rate)`,
    '',
  ];

  // By operation name
  const names = Object.entries(report.byName).sort((a, b) => b[1].totalMs - a[1].totalMs);
  if (names.length > 0) {
    lines.push('By Operation:');
    for (const [name, stats] of names) {
      const avgMs = (stats.totalMs / stats.count).toFixed(0);
      const errSuffix = stats.errors > 0 ? ` (${stats.errors} errors)` : '';
      lines.push(`  ${name}: ${stats.count}x, avg ${avgMs}ms${errSuffix}`);
    }
    lines.push('');
  }

  // By model
  const models = Object.entries(report.byModel).sort((a, b) => b[1].count - a[1].count);
  if (models.length > 0) {
    lines.push('By Model:');
    for (const [model, stats] of models) {
      lines.push(`  ${model}: ${stats.count} calls, ${stats.inputTokens} in / ${stats.outputTokens} out`);
    }
    lines.push('');
  }

  if (report.spanCount === 0) {
    lines.push('No trace data available for this scope.');
  }

  return lines.join('\n');
}

export function registerTraceReportTools(server: McpServer): void {
  server.tool(
    'trace_report',
    'View span-level trace data for AI operations. Shows operation timings, token usage, cache hit rates, and error rates. Zero-cost for session spans.',
    {
      scope: z.enum(['session', 'today', 'date']).default('session')
        .describe('Scope: "session" (current), "today" (all today), or "date" (specific date)'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
        .describe('Date for "date" scope (YYYY-MM-DD)'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    withErrorTracking('trace_report', async ({ scope, date }) => {
      let spans;
      let scopeLabel: string;

      switch (scope) {
        case 'session':
          spans = getSessionSpans();
          scopeLabel = 'current session';
          break;
        case 'today':
          spans = getSpansForDate(new Date().toISOString().split('T')[0]);
          scopeLabel = 'today';
          break;
        case 'date':
          if (!date) {
            return { content: [{ type: 'text' as const, text: 'Date parameter required for "date" scope (YYYY-MM-DD).' }] };
          }
          spans = getSpansForDate(date);
          scopeLabel = date;
          break;
        default:
          spans = getSessionSpans();
          scopeLabel = 'current session';
      }

      const report = aggregateTraces(spans);
      const text = formatReport(report, scopeLabel);

      logger.info('Trace report generated', { scope, spanCount: report.spanCount });

      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: report,
      };
    })
  );
}
