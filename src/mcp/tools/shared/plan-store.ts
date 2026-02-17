/**
 * Plan Store
 *
 * Persists sprint plans from the conductor pipeline for traceability.
 * Plans are saved to knowledge/plans/{id}.json and can be matched
 * against git commits to verify plan execution.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../../../config/paths.js';
import { logger } from '../../../config/logger.js';
import type { DecomposedTask } from './decomposition.js';

// ============================================
// Types
// ============================================

export type PlannedTaskStatus = 'planned' | 'committed' | 'skipped' | 'unplanned';

export interface PlannedTask {
  id: number;
  title: string;
  type: string;
  files: string[];
  estimateMinutes: number;
  status: PlannedTaskStatus;
}

export interface StoredPlan {
  id: string;
  feature: string;
  createdAt: string;
  tasks: PlannedTask[];
  unplannedCommits: string[];
  validationWarnings?: string[];
}

// ============================================
// Helpers
// ============================================

function getPlansDir(): string {
  const config = getConfig();
  return join(config.knowledgeDir, 'plans');
}

function ensurePlansDir(): string {
  const dir = getPlansDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Generate a plan ID from current timestamp + feature slug.
 */
export function generatePlanId(feature: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const slug = feature
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
  return `${date}-${slug}`;
}

// ============================================
// CRUD Operations
// ============================================

/**
 * Save a plan to the plans directory.
 * Uses atomic write (temp file + rename) to prevent corruption.
 */
export function savePlan(plan: StoredPlan): void {
  const dir = ensurePlansDir();
  const filePath = join(dir, `${plan.id}.json`);
  const tempPath = `${filePath}.tmp`;

  try {
    writeFileSync(tempPath, JSON.stringify(plan, null, 2));
    renameSync(tempPath, filePath);
    logger.info('Plan saved', { id: plan.id, taskCount: plan.tasks.length });
  } catch (error) {
    logger.error('Failed to save plan', { id: plan.id, error: String(error) });
    throw error;
  }
}

/**
 * Load a plan by ID.
 */
export function loadPlan(id: string): StoredPlan | null {
  const filePath = join(getPlansDir(), `${id}.json`);
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    logger.error('Failed to load plan', { id, error: String(error) });
    return null;
  }
}

/**
 * Load the most recently created plan.
 */
export function loadLatestPlan(): StoredPlan | null {
  const dir = getPlansDir();
  if (!existsSync(dir)) return null;

  try {
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .sort()
      .reverse();

    if (files.length === 0) return null;

    return JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'));
  } catch (error) {
    logger.error('Failed to load latest plan', { error: String(error) });
    return null;
  }
}

/**
 * Update the status of a task in a stored plan.
 */
export function updateTaskStatus(planId: string, taskId: number, status: PlannedTaskStatus): boolean {
  const plan = loadPlan(planId);
  if (!plan) return false;

  const task = plan.tasks.find(t => t.id === taskId);
  if (!task) return false;

  const updatedPlan: StoredPlan = {
    ...plan,
    tasks: plan.tasks.map(t =>
      t.id === taskId ? { ...t, status } : t,
    ),
  };

  savePlan(updatedPlan);
  return true;
}

/**
 * Create a StoredPlan from conductor decomposition output.
 */
export function createPlanFromDecomposition(
  feature: string,
  tasks: DecomposedTask[],
): StoredPlan {
  return {
    id: generatePlanId(feature),
    feature,
    createdAt: new Date().toISOString(),
    tasks: tasks.map(t => ({
      id: t.id,
      title: t.title,
      type: t.type,
      files: t.files,
      estimateMinutes: t.estimateMinutes,
      status: 'planned' as const,
    })),
    unplannedCommits: [],
  };
}

/**
 * Match git commit messages against planned tasks.
 * Returns which tasks were committed, which were skipped, and which commits were unplanned.
 */
export function matchCommitsToTasks(
  plan: StoredPlan,
  commitMessages: string[],
): StoredPlan {
  const updatedTasks = plan.tasks.map(task => {
    const matched = commitMessages.some(msg =>
      fuzzyMatch(msg, task.title),
    );
    return {
      ...task,
      status: matched ? 'committed' as const : task.status,
    };
  });

  const matchedMessages = new Set<string>();
  for (const msg of commitMessages) {
    const matched = plan.tasks.some(task => fuzzyMatch(msg, task.title));
    if (!matched) {
      matchedMessages.add(msg);
    }
  }

  return {
    ...plan,
    tasks: updatedTasks,
    unplannedCommits: [...matchedMessages],
  };
}

/**
 * Simple fuzzy match: check if commit message contains significant words from the task title.
 * At least 60% of significant words must appear in the message.
 */
export function fuzzyMatch(commitMessage: string, taskTitle: string): boolean {
  const stopWords = new Set(['a', 'an', 'the', 'to', 'for', 'in', 'on', 'at', 'and', 'or', 'of', 'with']);

  const titleWords = taskTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  if (titleWords.length === 0) return false;

  const msgLower = commitMessage.toLowerCase();
  const matched = titleWords.filter(word => msgLower.includes(word)).length;

  return matched / titleWords.length >= 0.6;
}

/**
 * Generate a traceability report from a plan.
 */
export function formatTraceabilityReport(plan: StoredPlan): string {
  const committed = plan.tasks.filter(t => t.status === 'committed').length;
  const skipped = plan.tasks.filter(t => t.status === 'planned').length; // still 'planned' = skipped
  const total = plan.tasks.length;

  const lines: string[] = [
    '### Plan Traceability Report',
    '',
    `**Feature:** ${plan.feature}`,
    `**Plan ID:** ${plan.id}`,
    `**Created:** ${plan.createdAt}`,
    '',
    `**Coverage:** ${committed}/${total} planned tasks committed, ${skipped} not matched`,
  ];

  if (plan.unplannedCommits.length > 0) {
    lines.push(`**Unplanned commits:** ${plan.unplannedCommits.length}`);
    for (const msg of plan.unplannedCommits.slice(0, 5)) {
      lines.push(`  - ${msg.substring(0, 80)}`);
    }
    if (plan.unplannedCommits.length > 5) {
      lines.push(`  - ...and ${plan.unplannedCommits.length - 5} more`);
    }
  }

  lines.push('');
  lines.push('| # | Title | Status |');
  lines.push('|---|-------|--------|');
  for (const t of plan.tasks) {
    const icon = t.status === 'committed' ? 'OK' : t.status === 'skipped' ? 'SKIP' : 'MISS';
    lines.push(`| ${t.id} | ${t.title} | ${icon} |`);
  }

  return lines.join('\n');
}
