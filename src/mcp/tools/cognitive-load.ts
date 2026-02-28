/**
 * MCP Cognitive Load Prediction Tool
 *
 * Zero-cost context window overflow prediction (NO AI calls, $0 cost).
 * Estimates token usage per remaining sprint task based on task type,
 * file count, and description complexity. Predicts overflow points
 * and recommends optimal compaction timing.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { withErrorTracking } from '../with-error-tracking.js';
import { logger } from '../../config/logger.js';
import { getConfig } from '../../config/paths.js';

/** Approximate context window size in tokens */
const CONTEXT_WINDOW_TOKENS = 200_000;

/** Warning threshold as fraction of context window */
const WARNING_THRESHOLD = 0.80;

/** Critical threshold as fraction of context window */
const CRITICAL_THRESHOLD = 0.95;

/** Default context usage when not provided */
const DEFAULT_CONTEXT_USAGE_PERCENT = 30;

/** Base token estimates by task type */
const TOKEN_ESTIMATES_BY_TYPE: Record<string, number> = {
  feature: 8000,
  fix: 4000,
  refactor: 6000,
  test: 5000,
  docs: 3000,
  migration: 3000,
};

/** Default token estimate for unknown task types */
const DEFAULT_TOKEN_ESTIMATE = 5000;

/** Additional tokens per file (reading + editing overhead) */
const TOKENS_PER_FILE = 1500;

/** Description length breakpoints for complexity multiplier */
const SHORT_DESCRIPTION_THRESHOLD = 50;
const LONG_DESCRIPTION_THRESHOLD = 200;

/** Complexity multipliers based on description length */
const SHORT_DESCRIPTION_MULTIPLIER = 0.8;
const LONG_DESCRIPTION_MULTIPLIER = 1.3;

export interface TaskInput {
  title: string;
  description: string;
  files?: string[];
  type?: string;
}

export interface TaskEstimate {
  title: string;
  estimatedTokens: number;
  runningTotal: number;
  overflowRisk: boolean;
}

export interface CognitiveLoadResult {
  status: 'safe' | 'warning' | 'critical';
  totalEstimatedTokens: number;
  contextCapacity: number;
  currentUsageTokens: number;
  tasks: TaskEstimate[];
  compactionPoint: number | null;
  recommendation: string;
}

/**
 * Calculate description length complexity multiplier.
 * Short descriptions suggest simple tasks, long descriptions suggest complexity.
 */
function descriptionMultiplier(description: string): number {
  const length = description.length;
  if (length <= SHORT_DESCRIPTION_THRESHOLD) return SHORT_DESCRIPTION_MULTIPLIER;
  if (length >= LONG_DESCRIPTION_THRESHOLD) return LONG_DESCRIPTION_MULTIPLIER;
  return 1.0;
}

/**
 * Estimate token usage for a single task.
 */
function estimateTaskTokens(task: TaskInput): number {
  const taskType = (task.type ?? '').toLowerCase();
  const baseTokens = TOKEN_ESTIMATES_BY_TYPE[taskType] ?? DEFAULT_TOKEN_ESTIMATE;
  const fileTokens = (task.files?.length ?? 0) * TOKENS_PER_FILE;
  const multiplier = descriptionMultiplier(task.description);

  return Math.round((baseTokens + fileTokens) * multiplier);
}

/**
 * Find the optimal compaction point: the last task index where the running
 * total is still below the warning threshold. Returns null if no compaction
 * is needed (all tasks fit safely) or if even the first task overflows.
 */
function findCompactionPoint(
  tasks: TaskEstimate[],
  warningTokens: number,
): number | null {
  let compactionIndex: number | null = null;

  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i].runningTotal > warningTokens && compactionIndex === null) {
      // The compaction point is the task just before overflow
      compactionIndex = i > 0 ? i - 1 : 0;
    }
  }

  return compactionIndex;
}

/**
 * Generate an actionable recommendation based on current context usage percentage.
 * Returns a concise recommendation string for immediate use.
 */
export function getContextRecommendation(usagePercent: number): string {
  if (usagePercent < 60) return 'Proceed normally.';
  if (usagePercent < 75) return 'Consider compacting after current task.';
  if (usagePercent < 90) return 'Compact now — use /strategic-compact.';
  return 'CRITICAL: Compact immediately or risk context loss.';
}

/**
 * Generate a human-readable recommendation based on status and compaction point.
 */
function generateRecommendation(
  status: 'safe' | 'warning' | 'critical',
  compactionPoint: number | null,
  tasks: TaskEstimate[],
  contextUsagePercent?: number,
): string {
  // If no tasks but we have usage info, give context-based recommendation
  if (tasks.length === 0 && contextUsagePercent !== undefined) {
    return getContextRecommendation(contextUsagePercent);
  }
  if (tasks.length === 0) {
    return 'No remaining tasks. Context window is clear.';
  }

  const baseRecommendation = (() => {
    switch (status) {
      case 'safe':
        return 'All tasks fit comfortably within the context window. No compaction needed.';
      case 'warning':
        return compactionPoint !== null
          ? `Approaching context limit. Recommend compaction after task ${compactionPoint + 1} ("${tasks[compactionPoint].title}") to maintain headroom.`
          : 'Approaching context limit. Consider compacting soon to maintain headroom.';
      case 'critical':
        return compactionPoint !== null
          ? `Context overflow predicted. Compact after task ${compactionPoint + 1} ("${tasks[compactionPoint].title}") or split the sprint into smaller batches.`
          : 'Context overflow predicted before completing tasks. Compact now or split the sprint.';
    }
  })();

  // Append immediate action if context is already high
  if (contextUsagePercent !== undefined && contextUsagePercent >= 75) {
    return `${baseRecommendation} **Immediate:** ${getContextRecommendation(contextUsagePercent)}`;
  }
  return baseRecommendation;
}

/**
 * Core cognitive load estimation logic. Exported for direct reuse
 * by other tools (e.g., sprint conductor).
 */
export function estimateCognitiveLoad(
  tasks: TaskInput[],
  contextUsagePercent?: number,
): CognitiveLoadResult {
  const usagePercent = contextUsagePercent ?? DEFAULT_CONTEXT_USAGE_PERCENT;
  const currentUsageTokens = Math.round((usagePercent / 100) * CONTEXT_WINDOW_TOKENS);
  const warningTokens = Math.round(CONTEXT_WINDOW_TOKENS * WARNING_THRESHOLD);
  const criticalTokens = Math.round(CONTEXT_WINDOW_TOKENS * CRITICAL_THRESHOLD);

  let runningTotal = currentUsageTokens;
  let hasCritical = false;
  let hasWarning = false;

  const taskEstimates: TaskEstimate[] = tasks.map((task) => {
    const estimatedTokens = estimateTaskTokens(task);
    runningTotal = runningTotal + estimatedTokens;

    const overflowRisk = runningTotal > warningTokens;
    if (runningTotal > criticalTokens) hasCritical = true;
    if (runningTotal > warningTokens) hasWarning = true;

    return {
      title: task.title,
      estimatedTokens,
      runningTotal,
      overflowRisk,
    };
  });

  const totalEstimatedTokens = taskEstimates.length > 0
    ? taskEstimates[taskEstimates.length - 1].runningTotal - currentUsageTokens
    : 0;

  const status: 'safe' | 'warning' | 'critical' = hasCritical
    ? 'critical'
    : hasWarning
      ? 'warning'
      : 'safe';

  const compactionPoint = status === 'safe'
    ? null
    : findCompactionPoint(taskEstimates, warningTokens);

  const recommendation = generateRecommendation(status, compactionPoint, taskEstimates, usagePercent);

  return {
    status,
    totalEstimatedTokens,
    contextCapacity: CONTEXT_WINDOW_TOKENS,
    currentUsageTokens,
    tasks: taskEstimates,
    compactionPoint,
    recommendation,
  };
}

/**
 * Format cognitive load result as a readable report.
 */
function formatReport(result: CognitiveLoadResult): string {
  const lines: string[] = [
    '# Cognitive Load Prediction',
    '',
    `**Status:** ${result.status.toUpperCase()}`,
    `**Context capacity:** ${result.contextCapacity.toLocaleString()} tokens`,
    `**Current usage:** ${result.currentUsageTokens.toLocaleString()} tokens (${Math.round((result.currentUsageTokens / result.contextCapacity) * 100)}%)`,
    `**Estimated remaining:** ${result.totalEstimatedTokens.toLocaleString()} tokens`,
    `**Projected total:** ${(result.currentUsageTokens + result.totalEstimatedTokens).toLocaleString()} tokens (${Math.round(((result.currentUsageTokens + result.totalEstimatedTokens) / result.contextCapacity) * 100)}%)`,
    '',
  ];

  if (result.tasks.length > 0) {
    lines.push('| # | Task | Est. Tokens | Running Total | Risk |');
    lines.push('|---|------|-------------|---------------|------|');

    for (let i = 0; i < result.tasks.length; i++) {
      const t = result.tasks[i];
      const risk = t.overflowRisk ? 'OVERFLOW' : 'OK';
      const compactMarker = result.compactionPoint === i ? ' << COMPACT HERE' : '';
      lines.push(`| ${i + 1} | ${t.title} | ${t.estimatedTokens.toLocaleString()} | ${t.runningTotal.toLocaleString()} | ${risk}${compactMarker} |`);
    }

    lines.push('');
  }

  lines.push(`**Recommendation:** ${result.recommendation}`);

  return lines.join('\n');
}

// ============================================
// Calibration Recording
// ============================================

interface CalibrationEntry {
  date: string;
  sprint: string;
  taskCount: number;
  contextUsagePercent: number;
  actualTokensUsed?: number;
}

interface CalibrationData {
  entries: CalibrationEntry[];
}

function getCalibrationPath(): string {
  const dir = getConfig().knowledgeDir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, 'cognitive-calibration.json');
}

function loadCalibrationData(): CalibrationData {
  const path = getCalibrationPath();
  if (!existsSync(path)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CalibrationData;
  } catch {
    return { entries: [] };
  }
}

/**
 * Record cognitive calibration data at sprint completion.
 * Over time, this data can be used to adjust TOKEN_ESTIMATES_BY_TYPE.
 */
export function recordCognitiveCalibration(params: {
  sprint: string;
  taskCount: number;
  contextUsagePercent: number;
}): void {
  const data = loadCalibrationData();

  const entry: CalibrationEntry = {
    date: new Date().toISOString(),
    sprint: params.sprint,
    taskCount: params.taskCount,
    contextUsagePercent: params.contextUsagePercent,
  };

  const updated: CalibrationData = {
    entries: [...data.entries, entry],
  };

  writeFileSync(getCalibrationPath(), JSON.stringify(updated, null, 2));

  logger.info('Cognitive calibration recorded', {
    sprint: params.sprint,
    taskCount: params.taskCount,
    contextUsagePercent: params.contextUsagePercent,
  });
}

export function registerCognitiveLoadTools(server: McpServer): void {
  server.tool(
    'cognitive_load',
    'Predict context window overflow for remaining sprint tasks. Zero-cost estimation of token usage per task with compaction recommendations. Example: { "remaining_tasks": [{ "title": "Add API", "description": "Create REST endpoint", "type": "feature", "files": ["route.ts"] }] }',
    {
      remaining_tasks: z.array(z.object({
        title: z.string(),
        description: z.string(),
        files: z.array(z.string()).optional(),
        type: z.string().optional(),
      })).describe('Remaining sprint tasks'),
      context_usage_percent: z.number().min(0).max(100).optional()
        .describe('Current context window usage percentage (0-100)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    withErrorTracking('cognitive_load', async ({ remaining_tasks, context_usage_percent }) => {
      logger.info('Cognitive load prediction started', {
        taskCount: remaining_tasks.length,
        contextUsagePercent: context_usage_percent,
      });

      const result = estimateCognitiveLoad(remaining_tasks, context_usage_percent);

      logger.info('Cognitive load prediction complete', {
        status: result.status,
        totalEstimatedTokens: result.totalEstimatedTokens,
        compactionPoint: result.compactionPoint,
      });

      const report = formatReport(result);

      return { content: [{ type: 'text' as const, text: report }] };
    }),
  );
}
