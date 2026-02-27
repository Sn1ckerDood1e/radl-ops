/**
 * Weekly Batch Failure Analysis
 *
 * Parses watcher logs to identify systemic failure patterns.
 * Groups failures by type (git, typecheck, timeout, claude error)
 * and uses Haiku to recommend fixes.
 *
 * Cost: ~$0.002 per analysis (Haiku).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { getConfig } from '../../config/paths.js';
import { getRoute, calculateCost } from '../../models/router.js';
import { trackUsage } from '../../models/token-tracker.js';
import { getAnthropicClient } from '../../config/anthropic.js';
import { withRetry } from '../../utils/retry.js';
import type Anthropic from '@anthropic-ai/sdk';

// ============================================
// Types
// ============================================

interface FailureEntry {
  date: string;
  issueNum: number;
  type: 'git' | 'typecheck' | 'timeout' | 'claude_error' | 'unknown';
  message: string;
  logFile: string;
}

interface FailureReport {
  period: string;
  totalFailures: number;
  byType: Record<string, number>;
  entries: FailureEntry[];
  analysis: string;
  recommendations: string[];
  costUsd: number;
}

// ============================================
// Log Parsing
// ============================================

const FAILURE_PATTERNS: Array<{ type: FailureEntry['type']; pattern: RegExp }> = [
  { type: 'git', pattern: /(?:fatal|error):.*(?:git|merge|conflict|push|pull|checkout)/i },
  { type: 'typecheck', pattern: /(?:error TS\d+|typecheck failed|tsc.*error|type error)/i },
  { type: 'timeout', pattern: /(?:timeout|timed out|exceeded.*time|WATCHER_TIMEOUT)/i },
  { type: 'claude_error', pattern: /(?:claude.*error|API.*error|rate.*limit|overloaded|529)/i },
];

function classifyFailure(message: string): FailureEntry['type'] {
  for (const { type, pattern } of FAILURE_PATTERNS) {
    if (pattern.test(message)) {
      return type;
    }
  }
  return 'unknown';
}

function parseWatcherLogs(daysBack: number): FailureEntry[] {
  const config = getConfig();
  const logsDir = join(config.radlOpsDir, 'logs', 'watcher');

  if (!existsSync(logsDir)) {
    return [];
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const entries: FailureEntry[] = [];

  try {
    const files = readdirSync(logsDir, { encoding: 'utf-8' });

    for (const file of files) {
      if (!file.endsWith('.log')) continue;

      // Extract date from filename: YYYY-MM-DD-issue-NNN.log
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch || dateMatch[1] < cutoffStr) continue;

      const issueMatch = file.match(/issue-(\d+)/);
      const issueNum = issueMatch ? parseInt(issueMatch[1], 10) : 0;

      const filePath = join(logsDir, file);
      try {
        const content = readFileSync(filePath, 'utf-8');

        // Look for failure indicators
        const failureLines = content.split('\n').filter(line =>
          /(?:FAILED|ERROR|TIMEOUT|fatal)/i.test(line) &&
          !/(?:debug|info)/i.test(line.substring(0, 10))
        );

        for (const line of failureLines) {
          const trimmed = line.trim().substring(0, 200);
          entries.push({
            date: dateMatch[1],
            issueNum,
            type: classifyFailure(trimmed),
            message: trimmed,
            logFile: file,
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch (error) {
    logger.warn('Failed to read watcher logs directory', { error: String(error) });
  }

  return entries;
}

// ============================================
// AI Analysis
// ============================================

async function analyzeFailures(entries: FailureEntry[]): Promise<{ analysis: string; recommendations: string[]; costUsd: number }> {
  if (entries.length === 0) {
    return { analysis: 'No failures found in the analysis period.', recommendations: [], costUsd: 0 };
  }

  const byType: Record<string, number> = {};
  for (const entry of entries) {
    byType[entry.type] = (byType[entry.type] ?? 0) + 1;
  }

  const failureSummary = entries
    .slice(0, 30) // Cap to avoid token overflow
    .map(e => `[${e.date}] Issue #${e.issueNum} (${e.type}): ${e.message}`)
    .join('\n');

  const prompt = `Analyze these watcher failure patterns from the past week. Identify systemic issues and recommend fixes.

## Failure Summary
Total: ${entries.length} failures
By type: ${Object.entries(byType).map(([t, c]) => `${t}: ${c}`).join(', ')}

## Failure Details
${failureSummary}

Provide:
1. Root cause analysis (what systemic issues are causing repeated failures?)
2. 3-5 specific, actionable recommendations to reduce failure rate
3. Priority ranking of recommendations (most impactful first)

Be specific and reference the failure types/messages. Don't give generic advice.`;

  const route = getRoute('spot_check');

  const response = await withRetry(
    () => getAnthropicClient().messages.create({
      model: route.model,
      max_tokens: route.maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
    { maxRetries: 2, baseDelayMs: 1000 },
  );

  const costUsd = calculateCost(
    route.model,
    response.usage.input_tokens,
    response.usage.output_tokens,
  );

  trackUsage(
    route.model,
    response.usage.input_tokens,
    response.usage.output_tokens,
    'spot_check',
    'failure-analysis',
  );

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  // Extract recommendations as bullet points
  const recommendations = text
    .split('\n')
    .filter(line => /^\s*[-\d.*]/.test(line) && line.length > 20)
    .map(line => line.replace(/^\s*[-\d.*]+\s*/, '').trim())
    .slice(0, 5);

  return {
    analysis: text,
    recommendations,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
  };
}

// ============================================
// Exportable Core Logic
// ============================================

/**
 * Run weekly failure analysis on watcher logs.
 * Used by weekly_briefing to include failure trends.
 */
export async function runFailureAnalysis(daysBack: number = 7): Promise<FailureReport> {
  const entries = parseWatcherLogs(daysBack);

  const byType: Record<string, number> = {};
  for (const entry of entries) {
    byType[entry.type] = (byType[entry.type] ?? 0) + 1;
  }

  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);

  const { analysis, recommendations, costUsd } = await analyzeFailures(entries);

  return {
    period: `${startDate.toISOString().split('T')[0]} to ${endDate}`,
    totalFailures: entries.length,
    byType,
    entries,
    analysis,
    recommendations,
    costUsd,
  };
}

// ============================================
// MCP Tool Registration
// ============================================

export function registerFailureAnalysisTools(server: McpServer): void {
  server.tool(
    'weekly_failure_analysis',
    'Analyze watcher failure patterns from the past N days. Parses logs, groups by type (git/typecheck/timeout/claude_error), and uses Haiku AI to identify systemic issues and recommend fixes. Cost: ~$0.002.',
    {
      days_back: z.number().int().min(1).max(90).optional().default(7)
        .describe('Number of days to analyze (default: 7)'),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    withErrorTracking('weekly_failure_analysis', async ({ days_back }) => {
      const report = await runFailureAnalysis(days_back);

      if (report.totalFailures === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `## Weekly Failure Analysis\n\n**Period:** ${report.period}\n\nNo failures found. The watcher has been running cleanly.`,
          }],
        };
      }

      const byTypeLines = Object.entries(report.byType)
        .sort(([, a], [, b]) => b - a)
        .map(([type, count]) => `- **${type}**: ${count} failures`);

      const recentEntries = report.entries
        .slice(0, 10)
        .map(e => `- [${e.date}] #${e.issueNum} (${e.type}): ${e.message.substring(0, 100)}`);

      const lines = [
        '## Weekly Failure Analysis',
        '',
        `**Period:** ${report.period}`,
        `**Total failures:** ${report.totalFailures}`,
        `**Cost:** $${report.costUsd}`,
        '',
        '### By Type',
        ...byTypeLines,
        '',
        '### Recent Failures',
        ...recentEntries,
        '',
        '### Analysis',
        report.analysis,
      ];

      if (report.recommendations.length > 0) {
        lines.push('', '### Top Recommendations');
        for (const rec of report.recommendations) {
          lines.push(`1. ${rec}`);
        }
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }),
  );
}
