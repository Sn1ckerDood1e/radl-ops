/**
 * MCP Sprint Retrospective Tool
 *
 * Generates sprint retrospective reports by matching git commits
 * to stored plans, computing estimation accuracy, and flagging
 * unplanned work.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execSync } from 'child_process';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { getConfig } from '../../config/paths.js';
import {
  loadLatestPlan,
  loadPlan,
  matchCommitsToTasks,
  savePlan,
} from './shared/plan-store.js';
import type { StoredPlan } from './shared/plan-store.js';

// ============================================
// Types
// ============================================

export interface RetroResult {
  planId: string;
  feature: string;
  totalPlanned: number;
  committed: number;
  skipped: number;
  unplannedCommits: number;
  estimationAccuracy: number | null; // percentage (actual/predicted * 100)
  totalEstimatedMinutes: number;
  commitMessages: string[];
}

// ============================================
// Core Logic
// ============================================

/**
 * Get git commit messages for a branch range.
 */
export function getCommitMessages(cwd: string, range: string): string[] {
  try {
    const log = execSync(`git log --oneline --format="%s" ${range} 2>/dev/null || true`, {
      encoding: 'utf-8',
      cwd,
      timeout: 10000,
    }).trim();

    return log ? log.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Run retrospective analysis on a stored plan.
 */
export function runRetrospective(
  plan: StoredPlan,
  commitMessages: string[],
  actualMinutes?: number,
): RetroResult {
  const matched = matchCommitsToTasks(plan, commitMessages);

  const committed = matched.tasks.filter(t => t.status === 'committed').length;
  const skipped = matched.tasks.filter(t => t.status === 'planned').length;
  const totalEstimated = matched.tasks.reduce((sum, t) => sum + t.estimateMinutes, 0);

  let estimationAccuracy: number | null = null;
  if (actualMinutes && totalEstimated > 0) {
    estimationAccuracy = Math.round((actualMinutes / totalEstimated) * 100);
  }

  return {
    planId: plan.id,
    feature: plan.feature,
    totalPlanned: plan.tasks.length,
    committed,
    skipped,
    unplannedCommits: matched.unplannedCommits.length,
    estimationAccuracy,
    totalEstimatedMinutes: totalEstimated,
    commitMessages,
  };
}

/**
 * Format retrospective report for display.
 */
export function formatRetroReport(result: RetroResult): string {
  const lines: string[] = ['## Sprint Retrospective', ''];

  lines.push(`**Feature:** ${result.feature}`);
  lines.push(`**Plan:** ${result.planId}`);
  lines.push('');

  // Task coverage
  const coveragePct = result.totalPlanned > 0
    ? Math.round((result.committed / result.totalPlanned) * 100)
    : 0;
  lines.push(`### Task Coverage: ${result.committed}/${result.totalPlanned} (${coveragePct}%)`);
  if (result.skipped > 0) {
    lines.push(`- ${result.skipped} planned tasks not matched to any commit`);
  }
  if (result.unplannedCommits > 0) {
    lines.push(`- ${result.unplannedCommits} commits not matching any planned task`);
  }
  lines.push('');

  // Estimation accuracy
  if (result.estimationAccuracy !== null) {
    lines.push('### Estimation Accuracy');
    lines.push(`- Predicted: ${result.totalEstimatedMinutes} minutes`);
    lines.push(`- Accuracy ratio: ${result.estimationAccuracy}%`);
    if (result.estimationAccuracy < 80) {
      lines.push('- Under-estimated — plan took longer than predicted');
    } else if (result.estimationAccuracy > 120) {
      lines.push('- Over-estimated — plan completed faster than predicted');
    } else {
      lines.push('- Good estimate — within 20% of actual');
    }
  }
  lines.push('');

  // Commits
  lines.push(`### Commits (${result.commitMessages.length})`);
  for (const msg of result.commitMessages.slice(0, 10)) {
    lines.push(`- ${msg.substring(0, 80)}`);
  }
  if (result.commitMessages.length > 10) {
    lines.push(`- ...and ${result.commitMessages.length - 10} more`);
  }

  return lines.join('\n');
}

// ============================================
// MCP Registration
// ============================================

export function registerRetrospectiveTools(server: McpServer): void {
  const config = getConfig();

  server.tool(
    'sprint_retrospective',
    'Generate sprint retrospective: match commits to stored plan, compute task coverage and estimation accuracy, flag unplanned work.',
    {
      plan_id: z.string().optional()
        .describe('Plan ID to analyze (defaults to latest)'),
      commit_range: z.string().default('HEAD~20..HEAD')
        .describe('Git commit range to analyze (default: last 20 commits)'),
      actual_minutes: z.number().optional()
        .describe('Actual time spent in minutes (for estimation accuracy)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    withErrorTracking('sprint_retrospective', async ({ plan_id, commit_range, actual_minutes }) => {
      const plan = plan_id ? loadPlan(plan_id) : loadLatestPlan();

      if (!plan) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No stored plan found. Run sprint_conductor first to generate a plan.',
          }],
        };
      }

      const commits = getCommitMessages(config.radlDir, commit_range);

      if (commits.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No commits found in range "${commit_range}". Check branch or range.`,
          }],
        };
      }

      const result = runRetrospective(plan, commits, actual_minutes);

      // Save updated plan with commit matching
      const matched = matchCommitsToTasks(plan, commits);
      savePlan(matched);

      const output = formatRetroReport(result);

      logger.info('Sprint retrospective generated', {
        planId: plan.id,
        committed: result.committed,
        skipped: result.skipped,
        unplanned: result.unplannedCommits,
      });

      return {
        content: [{ type: 'text' as const, text: output }],
      };
    }),
  );
}
