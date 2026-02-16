/**
 * MCP Inverse Bloom Tool
 *
 * Zero-cost (NO AI calls, $0 cost) knowledge surfacing tool.
 * Given a list of tasks, scores each against all knowledge sources
 * (patterns, lessons, antibodies, crystallized checks, causal graph)
 * using keyword overlap, and returns "Watch out for" sections
 * with the top-5 most relevant items per task.
 *
 * Use before starting sprint execution to surface relevant
 * past learnings for each task in the plan.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../../config/logger.js';
import { getConfig } from '../../config/paths.js';

// ============================================
// Types
// ============================================

export interface InverseBloomResult {
  taskTitle: string;
  watchOutSection: string;
  matchedItems: Array<{ source: string; item: string; score: number }>;
}

interface Pattern {
  name: string;
  description: string;
  category?: string;
}

interface Lesson {
  situation: string;
  learning: string;
  frequency?: number;
}

interface Antibody {
  trigger: string;
  triggerKeywords: string[];
  check: string;
  active: boolean;
}

interface CrystallizedCheck {
  trigger: string;
  triggerKeywords: string[];
  check: string;
  status: string;
}

interface CausalNode {
  id: string;
  type: string;
  label: string;
  sprint?: string;
}

interface CausalEdge {
  from: string;
  to: string;
  strength: number;
  evidence?: string;
}

interface ScoredItem {
  source: string;
  item: string;
  score: number;
  displayText: string;
}

interface TaskInput {
  title: string;
  description: string;
  files?: string[];
}

// ============================================
// Constants
// ============================================

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'in', 'to', 'of', 'and', 'for', 'with',
  'on', 'at', 'by', 'it', 'or', 'be', 'as', 'do', 'if', 'no',
  'not', 'but', 'from', 'that', 'this', 'was', 'are', 'has', 'had',
  'have', 'will', 'can', 'all', 'its', 'than', 'so', 'up',
]);

const MAX_ITEMS_PER_TASK = 5;

// ============================================
// File I/O
// ============================================

function loadJsonSafe<T>(filename: string): T | null {
  const filePath = join(getConfig().knowledgeDir, filename);
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error) {
    logger.warn(`Inverse Bloom: failed to load ${filename}`, { error: String(error) });
    return null;
  }
}

// ============================================
// Scoring
// ============================================

/**
 * Tokenize a string into lowercase words with stopwords removed.
 * Splits on non-alphanumeric characters, filters short words and stopwords.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 1 && !STOPWORDS.has(word));
}

/**
 * Count keyword overlap between a set of keywords and a task's token set.
 * Keywords are assumed to already be cleaned (lowercase, no stopwords).
 */
function countKeywordOverlap(keywords: string[], taskTokens: Set<string>): number {
  let count = 0;
  for (const keyword of keywords) {
    if (taskTokens.has(keyword)) {
      count++;
    }
  }
  return count;
}

/**
 * Count word overlap between raw text fields and a task's token set.
 * Tokenizes each field, then counts overlap with the task tokens.
 */
function countTextOverlap(fields: string[], taskTokens: Set<string>): number {
  const fieldTokens = new Set<string>();
  for (const field of fields) {
    for (const token of tokenize(field)) {
      fieldTokens.add(token);
    }
  }

  let count = 0;
  for (const token of fieldTokens) {
    if (taskTokens.has(token)) {
      count++;
    }
  }
  return count;
}

// ============================================
// Knowledge Scoring
// ============================================

function scorePatterns(taskTokens: Set<string>): ScoredItem[] {
  const data = loadJsonSafe<{ patterns: Pattern[] }>('patterns.json');
  if (!data?.patterns) return [];

  const items: ScoredItem[] = [];
  for (const p of data.patterns) {
    const score = countTextOverlap([p.name, p.description], taskTokens);
    if (score > 0) {
      items.push({
        source: 'Pattern',
        item: p.name,
        score,
        displayText: `**[Pattern]** ${p.name}: ${p.description}`,
      });
    }
  }
  return items;
}

function scoreLessons(taskTokens: Set<string>): ScoredItem[] {
  const data = loadJsonSafe<{ lessons: Lesson[] }>('lessons.json');
  if (!data?.lessons) return [];

  const items: ScoredItem[] = [];
  for (const l of data.lessons) {
    const score = countTextOverlap([l.situation, l.learning], taskTokens);
    if (score > 0) {
      items.push({
        source: 'Lesson',
        item: l.situation,
        score,
        displayText: `**[Lesson]** ${l.learning}`,
      });
    }
  }
  return items;
}

function scoreAntibodies(taskTokens: Set<string>): ScoredItem[] {
  const data = loadJsonSafe<{ antibodies: Antibody[] }>('antibodies.json');
  if (!data?.antibodies) return [];

  const items: ScoredItem[] = [];
  for (const ab of data.antibodies) {
    if (!ab.active) continue;
    const score = countKeywordOverlap(ab.triggerKeywords, taskTokens);
    if (score > 0) {
      items.push({
        source: 'Antibody',
        item: ab.trigger,
        score,
        displayText: `**[Antibody]** ${ab.trigger}: ${ab.check}`,
      });
    }
  }
  return items;
}

function scoreCrystallized(taskTokens: Set<string>): ScoredItem[] {
  const data = loadJsonSafe<{ checks: CrystallizedCheck[] }>('crystallized.json');
  if (!data?.checks) return [];

  const items: ScoredItem[] = [];
  for (const c of data.checks) {
    if (c.status !== 'active') continue;
    const score = countKeywordOverlap(c.triggerKeywords, taskTokens);
    if (score > 0) {
      items.push({
        source: 'Crystallized',
        item: c.trigger,
        score,
        displayText: `**[Crystallized]** ${c.trigger}: ${c.check}`,
      });
    }
  }
  return items;
}

function scoreCausalNodes(taskTokens: Set<string>): ScoredItem[] {
  const data = loadJsonSafe<{ nodes: CausalNode[]; edges: CausalEdge[] }>('causal-graph.json');
  if (!data?.nodes) return [];

  const items: ScoredItem[] = [];
  for (const node of data.nodes) {
    const score = countTextOverlap([node.label], taskTokens);
    if (score > 0) {
      const sprintInfo = node.sprint ? ` (${node.sprint})` : '';
      items.push({
        source: 'CausalNode',
        item: node.label,
        score,
        displayText: `**[Causal]** ${node.label} [${node.type}]${sprintInfo}`,
      });
    }
  }
  return items;
}

// ============================================
// Core Logic
// ============================================

/**
 * Run Inverse Bloom analysis on a list of tasks.
 * For each task, scores all knowledge items by keyword overlap
 * and returns the top 5 most relevant items with formatted sections.
 *
 * Zero-cost: no AI calls, pure string matching.
 */
export function runInverseBloom(
  tasks: Array<{ title: string; description: string; files?: string[] }>,
): InverseBloomResult[] {
  const results: InverseBloomResult[] = [];

  for (const task of tasks) {
    const taskText = [
      task.title,
      task.description,
      ...(task.files ?? []),
    ].join(' ');

    const taskTokens = new Set(tokenize(taskText));

    // Score all knowledge sources
    const allItems: ScoredItem[] = [
      ...scorePatterns(taskTokens),
      ...scoreLessons(taskTokens),
      ...scoreAntibodies(taskTokens),
      ...scoreCrystallized(taskTokens),
      ...scoreCausalNodes(taskTokens),
    ];

    // Sort by score descending, take top 5
    const topItems = [...allItems]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_ITEMS_PER_TASK);

    // Build the "Watch out for" section
    const sectionLines: string[] = [];
    if (topItems.length > 0) {
      sectionLines.push(`### Watch out for: ${task.title}`);
      for (const item of topItems) {
        sectionLines.push(`- ${item.displayText}`);
      }
    } else {
      sectionLines.push(`### Watch out for: ${task.title}`);
      sectionLines.push('- _No relevant knowledge items found for this task._');
    }

    results.push({
      taskTitle: task.title,
      watchOutSection: sectionLines.join('\n'),
      matchedItems: topItems.map(item => ({
        source: item.source,
        item: item.item,
        score: item.score,
      })),
    });
  }

  return results;
}

// ============================================
// MCP Registration
// ============================================

export function registerInverseBloomTools(server: McpServer): void {
  server.tool(
    'inverse_bloom',
    'Zero-cost knowledge surfacing for sprint tasks. Scores each task against patterns, lessons, antibodies, crystallized checks, and causal graph nodes using keyword overlap. Returns top-5 relevant "Watch out for" items per task. Use before sprint execution to surface relevant past learnings. Cost: $0 (no AI calls).',
    {
      tasks: z.array(z.object({
        title: z.string().min(1).max(500).describe('Task title'),
        description: z.string().min(1).max(2000).describe('Task description'),
        files: z.array(z.string()).optional().describe('Files this task will touch'),
      })).min(1).max(20).describe('Array of tasks to analyze against knowledge base'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async ({ tasks }: { tasks: TaskInput[] }) => {
      logger.info('Inverse Bloom started', { taskCount: tasks.length });

      const results = runInverseBloom(tasks);

      const totalMatches = results.reduce(
        (sum, r) => sum + r.matchedItems.length,
        0,
      );

      logger.info('Inverse Bloom complete', {
        taskCount: tasks.length,
        totalMatches,
        perTask: results.map(r => ({
          title: r.taskTitle,
          matchCount: r.matchedItems.length,
        })),
      });

      // Format output
      const sections = results.map(r => r.watchOutSection);
      const header = `# Inverse Bloom: Knowledge Surfacing\n\n**Tasks analyzed:** ${tasks.length} | **Knowledge matches:** ${totalMatches}\n`;
      const output = [header, ...sections].join('\n\n');

      return {
        content: [{ type: 'text' as const, text: output }],
      };
    },
  );
}
