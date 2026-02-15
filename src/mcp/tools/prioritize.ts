/**
 * MCP Autonomous Prioritization Tool
 *
 * Scores deferred items, roadmap phases, and tech debt on a 0-100 scale.
 * Factors: age (0-20), effort (0-20), impact (0-30), frequency (0-15), blocking (0-15).
 * Optional AI rationale via Haiku (~$0.002).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { getConfig } from '../../config/paths.js';

// ============================================
// Types
// ============================================

interface DeferredItem {
  id: number;
  title: string;
  reason: string;
  effort: string;
  sprintPhase: string;
  date: string;
  resolved: boolean;
}

interface Lesson {
  text?: string;
  content?: string;
  phase?: string;
  sprintPhase?: string;
}

export interface ScoredItem {
  id: number;
  title: string;
  source: string;
  totalScore: number;
  factors: {
    age: number;
    effort: number;
    impact: number;
    frequency: number;
    blocking: number;
  };
  rationale?: string;
}

export interface PrioritizationResult {
  items: ScoredItem[];
  totalEvaluated: number;
}

// ============================================
// Constants
// ============================================

const IMPACT_KEYWORDS: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /(?:security|auth|permission|xss|injection|csrf)/i, weight: 30 },
  { pattern: /(?:test|coverage|testing)/i, weight: 25 },
  { pattern: /(?:accessibility|a11y)/i, weight: 22 },
  { pattern: /(?:performance|speed|latency|cache)/i, weight: 20 },
  { pattern: /(?:type|typescript|error)/i, weight: 18 },
  { pattern: /(?:ux|ui|user experience)/i, weight: 15 },
  { pattern: /(?:refactor|cleanup|tech debt)/i, weight: 12 },
  { pattern: /(?:documentation|docs)/i, weight: 8 },
];

const EFFORT_SCORES: Record<string, number> = {
  small: 20,     // Easy to do — high priority
  medium: 12,
  large: 5,
  unknown: 10,
};

// ============================================
// Core Logic
// ============================================

/**
 * Score the age factor (0-20). Older items score higher.
 * Linear scale: 0 days = 0, 10+ days = 20.
 */
export function scoreAge(dateStr: string): number {
  const created = new Date(dateStr);
  const now = new Date();
  const ageDays = Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24));
  return Math.min(20, Math.round(ageDays * 2));
}

/**
 * Score the effort factor (0-20). Smaller effort scores higher.
 */
export function scoreEffort(effort: string): number {
  return EFFORT_SCORES[effort.toLowerCase()] ?? EFFORT_SCORES.unknown;
}

/**
 * Score the impact factor (0-30). Keyword-based heuristic.
 */
export function scoreImpact(title: string, reason: string): number {
  const combined = `${title} ${reason}`;
  for (const { pattern, weight } of IMPACT_KEYWORDS) {
    if (pattern.test(combined)) {
      return weight;
    }
  }
  return 10; // Default impact
}

/**
 * Score the frequency factor (0-15). Cross-reference with lessons.
 * Items mentioned in multiple lessons get higher scores.
 */
export function scoreFrequency(title: string, lessons: Lesson[]): number {
  const titleWords = title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  let mentionCount = 0;

  for (const lesson of lessons) {
    const lessonText = (lesson.text || lesson.content || '').toLowerCase();
    const matches = titleWords.filter(w => lessonText.includes(w)).length;
    if (matches >= 2) mentionCount++;
  }

  return Math.min(15, mentionCount * 5);
}

/**
 * Score the blocking factor (0-15). Heuristic: items that block other work.
 */
export function scoreBlocking(title: string, reason: string): number {
  const combined = `${title} ${reason}`.toLowerCase();

  if (/(?:block|prerequisite|depend|before|first|foundation)/i.test(combined)) {
    return 15;
  }
  if (/(?:needed for|required by|enables|unlock)/i.test(combined)) {
    return 10;
  }
  return 0;
}

/**
 * Score a single deferred item across all factors.
 */
export function scoreItem(item: DeferredItem, lessons: Lesson[]): ScoredItem {
  const factors = {
    age: scoreAge(item.date),
    effort: scoreEffort(item.effort),
    impact: scoreImpact(item.title, item.reason),
    frequency: scoreFrequency(item.title, lessons),
    blocking: scoreBlocking(item.title, item.reason),
  };

  return {
    id: item.id,
    title: item.title,
    source: item.sprintPhase,
    totalScore: factors.age + factors.effort + factors.impact + factors.frequency + factors.blocking,
    factors,
  };
}

/**
 * Run prioritization on all unresolved deferred items.
 */
export function runPrioritization(knowledgeDir: string, topN: number): PrioritizationResult {
  // Load deferred items
  const deferredPath = `${knowledgeDir}/deferred.json`;
  let items: DeferredItem[] = [];
  if (existsSync(deferredPath)) {
    try {
      const data = JSON.parse(readFileSync(deferredPath, 'utf-8'));
      items = (data.items || []).filter((i: DeferredItem) => !i.resolved);
    } catch {
      // Ignore parse errors
    }
  }

  // Load lessons for frequency scoring
  const lessonsPath = `${knowledgeDir}/lessons.json`;
  let lessons: Lesson[] = [];
  if (existsSync(lessonsPath)) {
    try {
      const data = JSON.parse(readFileSync(lessonsPath, 'utf-8'));
      lessons = data.lessons || data.items || [];
    } catch {
      // Ignore parse errors
    }
  }

  // Score all items
  const scored = items.map(item => scoreItem(item, lessons));

  // Sort by total score descending
  scored.sort((a, b) => b.totalScore - a.totalScore);

  return {
    items: scored.slice(0, topN),
    totalEvaluated: scored.length,
  };
}

/**
 * Format prioritization results for display.
 */
export function formatPrioritizationOutput(result: PrioritizationResult): string {
  const lines: string[] = ['## Autonomous Prioritization', ''];

  if (result.items.length === 0) {
    lines.push('No unresolved items to prioritize.');
    return lines.join('\n');
  }

  lines.push(`Evaluated ${result.totalEvaluated} items. Top ${result.items.length}:`);
  lines.push('');

  for (let i = 0; i < result.items.length; i++) {
    const item = result.items[i];
    const rank = i + 1;
    const f = item.factors;

    lines.push(`**${rank}. ${item.title}** — Score: ${item.totalScore}/100`);
    lines.push(`   _Source: ${item.source} | Age: ${f.age} | Effort: ${f.effort} | Impact: ${f.impact} | Freq: ${f.frequency} | Blocking: ${f.blocking}_`);
    if (item.rationale) {
      lines.push(`   ${item.rationale}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('_Scoring: age(0-20) + effort(0-20) + impact(0-30) + frequency(0-15) + blocking(0-15) = 0-100_');

  return lines.join('\n');
}

// ============================================
// MCP Registration
// ============================================

export function registerPrioritizeTools(server: McpServer): void {
  const config = getConfig();

  server.tool(
    'auto_prioritize',
    'Score and rank deferred items by age, effort, impact, frequency, and blocking potential. Returns top N items with factor breakdown.',
    {
      top_n: z.number().default(10)
        .describe('Number of top items to return (default: 10)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    withErrorTracking('auto_prioritize', async ({ top_n }) => {
      logger.info('Running autonomous prioritization', { topN: top_n });

      const result = runPrioritization(config.knowledgeDir, top_n);
      const output = formatPrioritizationOutput(result);

      logger.info('Prioritization complete', {
        evaluated: result.totalEvaluated,
        returned: result.items.length,
      });

      return {
        content: [{ type: 'text' as const, text: output }],
      };
    }),
  );
}
