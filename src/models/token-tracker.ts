/**
 * Token Tracker - Tracks API usage and costs per model
 *
 * Stores usage in append-only JSONL format for analytics.
 * In MCP mode, uses in-memory only (no disk I/O).
 * Provides daily/weekly summaries for briefings.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

import type { ModelId, TaskType, TokenUsage, CostAnalytics, CostAlert } from '../types/index.js';
import { calculateCost } from './router.js';
import { logger } from '../config/logger.js';

const USAGE_DIR = join(process.cwd(), 'usage-logs');

/**
 * Get the daily usage file path (rotated by date)
 */
function getUsageFile(date?: string): string {
  const d = date ?? new Date().toISOString().split('T')[0];
  return join(USAGE_DIR, `usage-${d}.jsonl`);
}

/**
 * In-memory cache of today's usage for fast summaries
 */
let todayUsage: TokenUsage[] = [];
let todayDate = new Date().toISOString().split('T')[0];

/**
 * Initialize the usage tracking directory
 */
export function initTokenTracker(): void {
  if (!existsSync(USAGE_DIR)) {
    mkdirSync(USAGE_DIR, { recursive: true });
  }
  loadTodayUsage();
  logger.info('Token tracker initialized', { usageDir: USAGE_DIR });
}

/**
 * Record a single API call's token usage
 */
export function trackUsage(
  model: ModelId,
  inputTokens: number,
  outputTokens: number,
  taskType: TaskType,
  toolName?: string,
  cacheReadTokens?: number,
  cacheWriteTokens?: number
): TokenUsage {
  const costUsd = calculateCost(model, inputTokens, outputTokens);

  const usage: TokenUsage = {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    timestamp: new Date(),
    taskType,
    toolName,
  };

  // Append to daily rotated JSONL file
  try {
    const line = JSON.stringify({
      ...usage,
      timestamp: usage.timestamp.toISOString(),
    }) + '\n';
    appendFileSync(getUsageFile(), line);
  } catch (error) {
    logger.error('Failed to write usage log', { error });
  }

  // Update in-memory cache
  const currentDate = new Date().toISOString().split('T')[0];
  if (currentDate !== todayDate) {
    todayUsage = [];
    todayDate = currentDate;
  }
  todayUsage = [...todayUsage, usage];

  logger.debug('Token usage tracked', {
    model,
    inputTokens,
    outputTokens,
    costUsd: costUsd.toFixed(6),
    taskType,
  });

  return usage;
}

/**
 * Get today's cost summary
 */
export function getTodaySummary(): CostAnalytics {
  const currentDate = new Date().toISOString().split('T')[0];
  if (currentDate !== todayDate) {
    todayUsage = [];
    todayDate = currentDate;
    loadTodayUsage();
  }

  return buildAnalytics(todayUsage, 'daily', currentDate, currentDate);
}

/**
 * Get analytics for a date range
 */
export function getAnalytics(
  startDate: string,
  endDate: string,
  period: 'daily' | 'weekly' | 'monthly' = 'daily'
): CostAnalytics {
  const allUsage = loadUsageRange(startDate, endDate);
  return buildAnalytics(allUsage, period, startDate, endDate);
}

/**
 * Get a formatted cost summary string for briefings
 */
export function getCostSummaryForBriefing(): string {
  const today = getTodaySummary();

  if (today.totalCostUsd === 0) {
    return 'No API usage recorded today.';
  }

  const lines = [
    `**API Costs Today**: $${today.totalCostUsd.toFixed(4)}`,
    `**Total Tokens**: ${(today.totalInputTokens + today.totalOutputTokens).toLocaleString()}`,
    '',
    '**By Model:**',
  ];

  for (const [model, data] of Object.entries(today.byModel)) {
    const shortName = model.split('-').slice(1, 2).join('');
    lines.push(`- ${shortName}: ${data.calls} calls, $${data.costUsd.toFixed(4)}`);
  }

  lines.push('', '**By Task:**');
  for (const [taskType, data] of Object.entries(today.byTaskType)) {
    lines.push(`- ${taskType}: ${data.calls} calls, $${data.costUsd.toFixed(4)}`);
  }

  if (today.totalCacheReadTokens > 0 || today.totalCacheWriteTokens > 0) {
    lines.push('', '**Prompt Caching:**');
    lines.push(`- Cache reads: ${today.totalCacheReadTokens.toLocaleString()} tokens`);
    lines.push(`- Cache writes: ${today.totalCacheWriteTokens.toLocaleString()} tokens`);
    lines.push(`- Estimated savings: $${today.estimatedCacheSavingsUsd.toFixed(4)}`);
  }

  return lines.join('\n');
}

/**
 * Build analytics from a list of usage entries
 */
function buildAnalytics(
  entries: TokenUsage[],
  period: 'daily' | 'weekly' | 'monthly',
  startDate: string,
  endDate: string
): CostAnalytics {
  const byModel: Record<string, { calls: number; costUsd: number; tokens: number }> = {};
  const byTaskType: Record<string, { calls: number; costUsd: number }> = {};
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;

  for (const entry of entries) {
    totalCost += entry.costUsd;
    totalInput += entry.inputTokens;
    totalOutput += entry.outputTokens;
    totalCacheRead += entry.cacheReadTokens ?? 0;
    totalCacheWrite += entry.cacheWriteTokens ?? 0;

    const modelKey = entry.model;
    if (!byModel[modelKey]) {
      byModel[modelKey] = { calls: 0, costUsd: 0, tokens: 0 };
    }
    byModel[modelKey] = {
      calls: byModel[modelKey].calls + 1,
      costUsd: byModel[modelKey].costUsd + entry.costUsd,
      tokens: byModel[modelKey].tokens + entry.inputTokens + entry.outputTokens,
    };

    const taskKey = entry.taskType;
    if (!byTaskType[taskKey]) {
      byTaskType[taskKey] = { calls: 0, costUsd: 0 };
    }
    byTaskType[taskKey] = {
      calls: byTaskType[taskKey].calls + 1,
      costUsd: byTaskType[taskKey].costUsd + entry.costUsd,
    };
  }

  // Estimate savings: cache reads cost 10% of normal input price
  // Average input price across models used (~$3/1M for Sonnet which dominates eval)
  const avgInputPrice = 3; // conservative estimate (Sonnet pricing)
  const estimatedSavings = totalCacheRead > 0
    ? (totalCacheRead / 1_000_000) * avgInputPrice * 0.9
    : 0;

  return {
    period,
    startDate,
    endDate,
    totalCostUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheReadTokens: totalCacheRead,
    totalCacheWriteTokens: totalCacheWrite,
    estimatedCacheSavingsUsd: Math.round(estimatedSavings * 1_000_000) / 1_000_000,
    byModel,
    byTaskType,
  };
}

/**
 * Load today's usage from disk into memory
 */
function loadTodayUsage(): void {
  const entries = loadUsageRange(todayDate, todayDate);
  todayUsage = entries;
}

/**
 * Load usage entries from daily JSONL files within a date range
 */
function loadUsageRange(startDate: string, endDate: string): TokenUsage[] {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const results: TokenUsage[] = [];

  // Iterate through each day in the range
  const current = new Date(start);
  while (current <= end) {
    const dateStr = current.toISOString().split('T')[0];
    const filePath = getUsageFile(dateStr);

    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);

        const dayEntries = lines
          .map(line => {
            try {
              const parsed = JSON.parse(line);
              return {
                ...parsed,
                timestamp: new Date(parsed.timestamp),
              } as TokenUsage;
            } catch {
              return null;
            }
          })
          .filter((entry): entry is TokenUsage => entry !== null);

        results.push(...dayEntries);
      } catch (error) {
        logger.error('Failed to load usage log', { error, file: filePath });
      }
    }

    current.setDate(current.getDate() + 1);
  }

  return results;
}

/**
 * Clean up usage logs older than retention days
 */
export function cleanupOldUsageLogs(retentionDays: number = 90): void {
  if (!existsSync(USAGE_DIR)) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  try {
    const files = readdirSync(USAGE_DIR, { encoding: 'utf-8' });

    for (const file of files) {
      if (!file.startsWith('usage-') || !file.endsWith('.jsonl')) continue;
      const dateStr = file.replace('usage-', '').replace('.jsonl', '');
      if (dateStr < cutoffStr) {
        unlinkSync(join(USAGE_DIR, file));
        logger.info('Cleaned up old usage log', { file });
      }
    }
  } catch (error) {
    logger.error('Failed to cleanup usage logs', { error });
  }
}

/**
 * Check daily cost against thresholds for alerting.
 * Returns alert level (ok/warn/critical) with descriptive message.
 */
export function checkCostThreshold(
  warnThreshold: number = 5,
  criticalThreshold: number = 15
): CostAlert {
  const summary = getTodaySummary();
  const cost = summary.totalCostUsd;

  if (cost >= criticalThreshold) {
    return {
      level: 'critical',
      dailyCost: cost,
      threshold: criticalThreshold,
      message: `CRITICAL: Daily API spend $${cost.toFixed(2)} exceeds $${criticalThreshold}`,
    };
  }
  if (cost >= warnThreshold) {
    return {
      level: 'warn',
      dailyCost: cost,
      threshold: warnThreshold,
      message: `WARNING: Daily API spend $${cost.toFixed(2)} exceeds $${warnThreshold}`,
    };
  }
  return {
    level: 'ok',
    dailyCost: cost,
    threshold: warnThreshold,
    message: `OK: Daily API spend $${cost.toFixed(2)}`,
  };
}
