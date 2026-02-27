/**
 * Watcher Metrics Tool
 *
 * Parses watcher logs and cost-summary.jsonl to compute:
 * - Pass@1: % of issues that succeed on first attempt
 * - Average cost per issue
 * - Average time per issue
 * - Failure rate by category
 * - Success trend over time (7-day rolling average)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { getConfig } from '../../config/paths.js';
import { getPromptVersions, formatVersionReport } from '../../knowledge/prompt-registry.js';

// ============================================
// Types
// ============================================

interface IssueRun {
  date: string;
  issueNum: number;
  success: boolean;
  costUsd: number;
  durationSecs: number;
  failureType?: string;
}

interface WatcherMetrics {
  period: string;
  totalIssues: number;
  passAt1: number;         // fraction that succeed on first attempt
  avgCostUsd: number;
  avgDurationMins: number;
  failuresByType: Record<string, number>;
  dailySuccessRate: Array<{ date: string; rate: number; count: number }>;
  promptVersions: string;
}

// ============================================
// Log Parsing
// ============================================

function parseIssueRuns(daysBack: number): IssueRun[] {
  const config = getConfig();
  const logsDir = join(config.radlOpsDir, 'logs', 'watcher');

  if (!existsSync(logsDir)) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const runs: IssueRun[] = [];

  // Parse cost-summary.jsonl for cost data
  const costSummaryPath = join(logsDir, 'cost-summary.jsonl');
  const costMap = new Map<number, number>();
  if (existsSync(costSummaryPath)) {
    try {
      const lines = readFileSync(costSummaryPath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { date?: string; issue?: number; cost_usd?: number };
          if (entry.issue && entry.date && entry.date >= cutoffStr) {
            costMap.set(entry.issue, entry.cost_usd ?? 0);
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Non-fatal
    }
  }

  // Parse log files for success/failure status
  try {
    const files = readdirSync(logsDir, { encoding: 'utf-8' });
    const logFiles = files
      .filter(f => f.endsWith('.log'))
      .sort();

    for (const file of logFiles) {
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch || dateMatch[1] < cutoffStr) continue;

      const issueMatch = file.match(/issue-(\d+)/);
      if (!issueMatch) continue;

      const issueNum = parseInt(issueMatch[1], 10);
      const filePath = join(logsDir, file);

      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        // Check for success/failure indicators
        const hasPR = lines.some(l => /(?:pull request|PR created|gh pr create)/i.test(l));
        const hasFailed = lines.some(l => /^.*FAILED/i.test(l));
        const hasTimeout = lines.some(l => /(?:TIMEOUT|timed out)/i.test(l));
        const hasCancelled = lines.some(l => /CANCELLED/i.test(l));

        if (hasCancelled) continue; // Skip cancelled issues

        const success = hasPR && !hasFailed;

        // Estimate duration from first/last timestamp
        let durationSecs = 0;
        const timestamps = lines
          .map(l => l.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/))
          .filter((m): m is RegExpMatchArray => m !== null)
          .map(m => new Date(m[1]).getTime());

        if (timestamps.length >= 2) {
          durationSecs = Math.round((timestamps[timestamps.length - 1] - timestamps[0]) / 1000);
        }

        let failureType: string | undefined;
        if (!success) {
          if (hasTimeout) failureType = 'timeout';
          else if (lines.some(l => /(?:typecheck|tsc.*error)/i.test(l))) failureType = 'typecheck';
          else if (lines.some(l => /(?:git.*error|merge conflict)/i.test(l))) failureType = 'git';
          else failureType = 'other';
        }

        runs.push({
          date: dateMatch[1],
          issueNum,
          success,
          costUsd: costMap.get(issueNum) ?? 0,
          durationSecs,
          failureType,
        });
      } catch {
        // Skip unreadable files
      }
    }
  } catch (error) {
    logger.warn('Failed to parse watcher logs for metrics', { error: String(error) });
  }

  return runs;
}

// ============================================
// Metrics Computation
// ============================================

function computeMetrics(runs: IssueRun[], daysBack: number): WatcherMetrics {
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);

  if (runs.length === 0) {
    return {
      period: `${startDate.toISOString().split('T')[0]} to ${endDate}`,
      totalIssues: 0,
      passAt1: 0,
      avgCostUsd: 0,
      avgDurationMins: 0,
      failuresByType: {},
      dailySuccessRate: [],
      promptVersions: formatVersionReport('watcher-prompt'),
    };
  }

  const successCount = runs.filter(r => r.success).length;
  const passAt1 = runs.length > 0 ? successCount / runs.length : 0;

  const totalCost = runs.reduce((s, r) => s + r.costUsd, 0);
  const avgCostUsd = runs.length > 0 ? totalCost / runs.length : 0;

  const totalDuration = runs.reduce((s, r) => s + r.durationSecs, 0);
  const avgDurationMins = runs.length > 0 ? (totalDuration / runs.length) / 60 : 0;

  // Failure breakdown
  const failuresByType: Record<string, number> = {};
  for (const run of runs.filter(r => !r.success)) {
    const type = run.failureType ?? 'unknown';
    failuresByType[type] = (failuresByType[type] ?? 0) + 1;
  }

  // Daily success rate
  const byDate = new Map<string, { success: number; total: number }>();
  for (const run of runs) {
    const existing = byDate.get(run.date) ?? { success: 0, total: 0 };
    byDate.set(run.date, {
      success: existing.success + (run.success ? 1 : 0),
      total: existing.total + 1,
    });
  }

  const dailySuccessRate = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { success, total }]) => ({
      date,
      rate: Math.round((success / total) * 100) / 100,
      count: total,
    }));

  return {
    period: `${startDate.toISOString().split('T')[0]} to ${endDate}`,
    totalIssues: runs.length,
    passAt1: Math.round(passAt1 * 100) / 100,
    avgCostUsd: Math.round(avgCostUsd * 1_000_000) / 1_000_000,
    avgDurationMins: Math.round(avgDurationMins * 10) / 10,
    failuresByType,
    dailySuccessRate,
    promptVersions: formatVersionReport('watcher-prompt'),
  };
}

// ============================================
// MCP Tool Registration
// ============================================

export function registerWatcherMetricsTools(server: McpServer): void {
  server.tool(
    'watcher_metrics',
    'Compute watcher success metrics: pass@1 rate, avg cost, avg duration, failure breakdown, daily success trend, and prompt version performance. Zero cost (log parsing only).',
    {
      days_back: z.number().int().min(1).max(90).optional().default(30)
        .describe('Number of days to analyze (default: 30)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    withErrorTracking('watcher_metrics', async ({ days_back }) => {
      const runs = parseIssueRuns(days_back);
      const metrics = computeMetrics(runs, days_back);

      const failureLines = Object.entries(metrics.failuresByType)
        .sort(([, a], [, b]) => b - a)
        .map(([type, count]) => `  - ${type}: ${count}`);

      const trendLines = metrics.dailySuccessRate
        .slice(-7)
        .map(d => `  ${d.date}: ${(d.rate * 100).toFixed(0)}% (${d.count} issues)`);

      const lines = [
        '## Watcher Metrics',
        '',
        `**Period:** ${metrics.period}`,
        `**Total issues:** ${metrics.totalIssues}`,
        `**Pass@1:** ${(metrics.passAt1 * 100).toFixed(0)}%`,
        `**Avg cost:** $${metrics.avgCostUsd.toFixed(4)}`,
        `**Avg duration:** ${metrics.avgDurationMins.toFixed(1)} min`,
        '',
      ];

      if (failureLines.length > 0) {
        lines.push('### Failures by Type', ...failureLines, '');
      }

      if (trendLines.length > 0) {
        lines.push('### Daily Trend (last 7 days)', ...trendLines, '');
      }

      // Include prompt version history
      const versions = getPromptVersions('watcher-prompt');
      if (versions.length > 0) {
        lines.push('### Prompt Versions', metrics.promptVersions);
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }),
  );
}
