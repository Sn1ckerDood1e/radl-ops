/**
 * MCP Knowledge Tools - Query compound learnings
 *
 * Surfaces patterns, lessons, and decisions from the knowledge base
 * so they're available in Claude Code sessions programmatically.
 * Supports keyword search across all text fields.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { getConfig } from '../../config/paths.js';

interface Pattern {
  id: number;
  name: string;
  description: string;
  example?: string;
  date: string;
}

interface Lesson {
  id: number;
  situation: string;
  learning: string;
  date: string;
}

interface Decision {
  id: number;
  title: string;
  context?: string;
  alternatives?: string;
  rationale: string;
  phase?: string;
  date: string;
}

interface DeferredItem {
  id: number;
  title: string;
  reason: string;
  effort: 'small' | 'medium' | 'large';
  sprintPhase: string;
  date: string;
  resolved: boolean;
}

interface TeamRun {
  id: number;
  sprintPhase: string;
  recipe: string;
  teammateCount: number;
  model: string;
  duration: string;
  findingsCount?: number;
  tasksCompleted?: number;
  outcome: 'success' | 'partial' | 'failed';
  lessonsLearned?: string;
  date: string;
}

interface ScoredEntry {
  type: 'pattern' | 'lesson' | 'decision' | 'deferred' | 'team-run';
  score: number;
  text: string;
}

function loadJson<T>(filename: string): T | null {
  const path = `${getConfig().knowledgeDir}/${filename}`;
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error) {
    logger.error(`Failed to read knowledge file: ${filename}`, { error: String(error) });
    return null;
  }
}

/**
 * Score an entry against search keywords.
 * Returns count of keyword matches across all text fields.
 */
function scoreEntry(keywords: string[], fields: string[]): number {
  let score = 0;
  for (const keyword of keywords) {
    for (const field of fields) {
      if (field.toLowerCase().includes(keyword)) {
        score++;
      }
    }
  }
  return score;
}

function formatPattern(p: Pattern): string {
  const lines = [`- **${p.name}**: ${p.description}`];
  if (p.example) lines.push(`  Example: \`${p.example}\``);
  return lines.join('\n');
}

function formatLesson(l: Lesson): string {
  return `- **Situation**: ${l.situation}\n  **Learning**: ${l.learning}`;
}

function formatDecision(d: Decision): string {
  const lines = [`- [${d.phase ?? '?'}] **${d.title}**`];
  if (d.rationale) lines.push(`  Rationale: ${d.rationale}`);
  return lines.join('\n');
}

function formatDeferred(d: DeferredItem): string {
  const status = d.resolved ? 'RESOLVED' : 'OPEN';
  return `- [DEFERRED] [${status}] **${d.title}** (${d.effort}, ${d.sprintPhase})\n  Reason: ${d.reason}`;
}

function formatTeamRun(r: TeamRun): string {
  const findings = r.findingsCount !== undefined ? `, ${r.findingsCount} findings` : '';
  const tasks = r.tasksCompleted !== undefined ? `, ${r.tasksCompleted} tasks` : '';
  const lesson = r.lessonsLearned ? `\n  Lesson: ${r.lessonsLearned}` : '';
  return `- [TEAM] [${r.outcome.toUpperCase()}] **${r.recipe}** recipe (${r.teammateCount} teammates, ${r.model}, ${r.duration}${findings}${tasks}) — ${r.sprintPhase}${lesson}`;
}

export function registerKnowledgeTools(server: McpServer): void {
  server.tool(
    'knowledge_query',
    'Query the compound learning knowledge base. Returns patterns to apply, lessons to avoid, and past decisions. Supports keyword search. Use at session start and before making architectural choices. Example: { "type": "lessons", "query": "enum migration" }',
    {
      type: z.enum(['all', 'patterns', 'lessons', 'decisions', 'team-runs']).optional()
        .describe('Type of knowledge to query (defaults to all)'),
      query: z.string().max(200).optional()
        .describe('Search keyword to filter results (searches names, descriptions, learnings, rationale)'),
      depth: z.enum(['brief', 'standard', 'full']).optional()
        .describe('Detail level: brief (counts only), standard (default), full (all entries with examples)'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    withErrorTracking('knowledge_query', async ({ type, query, depth }) => {
      const queryType = type ?? 'all';
      const detailLevel = depth ?? 'standard';

      // Brief mode: counts only, no content
      if (detailLevel === 'brief' && !query) {
        const counts = getKnowledgeCounts(queryType);
        return {
          content: [{ type: 'text' as const, text: counts.text }],
          structuredContent: counts.structured,
        };
      }

      // If no query, return all entries (existing behavior)
      if (!query) {
        const { text, structured } = formatAll(queryType, detailLevel);
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: structured,
        };
      }

      // Keyword search mode
      const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
      const scored: ScoredEntry[] = [];

      if (queryType === 'all' || queryType === 'patterns') {
        const data = loadJson<{ patterns: Pattern[] }>('patterns.json');
        for (const p of data?.patterns ?? []) {
          const score = scoreEntry(keywords, [p.name, p.description, p.example ?? '']);
          if (score > 0) {
            scored.push({ type: 'pattern', score, text: formatPattern(p) });
          }
        }
      }

      if (queryType === 'all' || queryType === 'lessons') {
        const data = loadJson<{ lessons: Lesson[] }>('lessons.json');
        for (const l of data?.lessons ?? []) {
          const score = scoreEntry(keywords, [l.situation, l.learning]);
          if (score > 0) {
            scored.push({ type: 'lesson', score, text: formatLesson(l) });
          }
        }
      }

      if (queryType === 'all' || queryType === 'decisions') {
        const data = loadJson<{ decisions: Decision[] }>('decisions.json');
        for (const d of data?.decisions ?? []) {
          const score = scoreEntry(keywords, [
            d.title, d.context ?? '', d.alternatives ?? '', d.rationale,
          ]);
          if (score > 0) {
            scored.push({ type: 'decision', score, text: formatDecision(d) });
          }
        }
      }

      // Always search deferred items (they're cross-cutting)
      {
        const data = loadJson<{ items: DeferredItem[] }>('deferred.json');
        for (const d of data?.items ?? []) {
          const score = scoreEntry(keywords, [d.title, d.reason, d.effort, d.sprintPhase]);
          if (score > 0) {
            scored.push({ type: 'deferred', score, text: formatDeferred(d) });
          }
        }
      }

      // Always search team runs (they're cross-cutting like deferred items)
      {
        const data = loadJson<{ runs: TeamRun[] }>('team-runs.json');
        for (const r of data?.runs ?? []) {
          const score = scoreEntry(keywords, [
            r.recipe, r.sprintPhase, r.model, r.outcome, r.lessonsLearned ?? '',
          ]);
          if (score > 0) {
            scored.push({ type: 'team-run', score, text: formatTeamRun(r) });
          }
        }
      }

      if (scored.length === 0) {
        logger.info('Knowledge search: no results', { query, type: queryType });
        return {
          content: [{
            type: 'text' as const,
            text: `No results for '${query}'. Try broader keywords or omit the query to see all entries.`,
          }],
          structuredContent: {
            query,
            type: queryType,
            totalMatches: 0,
            results: [],
          },
        };
      }

      // Sort by score descending, take top 10
      const top = [...scored]
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

      const lines = [`## Search results for '${query}' (${scored.length} matches, showing top ${top.length})`, ''];
      for (const entry of top) {
        lines.push(entry.text);
      }

      logger.info('Knowledge searched', { query, type: queryType, matches: scored.length });
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        structuredContent: {
          query,
          type: queryType,
          totalMatches: scored.length,
          results: top.map(entry => ({
            type: entry.type,
            score: entry.score,
            text: entry.text,
          })),
        },
      };
    })
  );
}

/**
 * Brief mode: return counts only
 */
function getKnowledgeCounts(queryType: string): { text: string; structured: Record<string, unknown> } {
  const counts: Record<string, number> = {};

  if (queryType === 'all' || queryType === 'patterns') {
    const data = loadJson<{ patterns: Pattern[] }>('patterns.json');
    counts.patterns = data?.patterns?.length ?? 0;
  }
  if (queryType === 'all' || queryType === 'lessons') {
    const data = loadJson<{ lessons: Lesson[] }>('lessons.json');
    counts.lessons = data?.lessons?.length ?? 0;
  }
  if (queryType === 'all' || queryType === 'decisions') {
    const data = loadJson<{ decisions: Decision[] }>('decisions.json');
    counts.decisions = data?.decisions?.length ?? 0;
  }
  if (queryType === 'all') {
    const data = loadJson<{ items: DeferredItem[] }>('deferred.json');
    const open = (data?.items ?? []).filter(d => !d.resolved).length;
    counts.deferredOpen = open;
  }
  if (queryType === 'all' || queryType === 'team-runs') {
    const data = loadJson<{ runs: TeamRun[] }>('team-runs.json');
    counts.teamRuns = data?.runs?.length ?? 0;
  }

  const lines = Object.entries(counts).map(([k, v]) => `${k}: ${v}`);
  const text = `Knowledge counts: ${lines.join(', ')}`;

  logger.info('Knowledge queried (brief)', { type: queryType, counts });
  return { text, structured: { type: queryType, depth: 'brief', counts } };
}

/**
 * Format all entries without search filtering (original behavior)
 */
function formatAll(queryType: string, depth: string = 'standard'): { text: string; structured: Record<string, unknown> } {
  const lines: string[] = [];
  const structured: Record<string, unknown> = { type: queryType };

  if (queryType === 'all' || queryType === 'patterns') {
    const data = loadJson<{ patterns: Pattern[] }>('patterns.json');
    const patterns = data?.patterns ?? [];
    lines.push(`## Patterns (${patterns.length})`, '');
    if (patterns.length === 0) {
      lines.push('No patterns recorded yet.', '');
    } else {
      for (const p of patterns) {
        lines.push(formatPattern(p));
      }
      lines.push('');
    }
    structured.patterns = patterns;
  }

  if (queryType === 'all' || queryType === 'lessons') {
    const data = loadJson<{ lessons: Lesson[] }>('lessons.json');
    const lessons = data?.lessons ?? [];
    lines.push(`## Lessons (${lessons.length})`, '');
    if (lessons.length === 0) {
      lines.push('No lessons recorded yet.', '');
    } else {
      for (const l of lessons) {
        lines.push(formatLesson(l));
      }
      lines.push('');
    }
    structured.lessons = lessons;
  }

  if (queryType === 'all' || queryType === 'decisions') {
    const data = loadJson<{ decisions: Decision[] }>('decisions.json');
    const decisions = data?.decisions ?? [];
    lines.push(`## Decisions (${decisions.length})`, '');
    if (decisions.length === 0) {
      lines.push('No decisions recorded yet.', '');
    } else {
      const displayDecisions = depth === 'full' ? decisions : decisions.slice(-10);
      for (const d of displayDecisions) {
        lines.push(formatDecision(d));
      }
      lines.push('');
    }
    structured.decisions = decisions;
  }

  // Always include deferred items in "all" view
  if (queryType === 'all') {
    const data = loadJson<{ items: DeferredItem[] }>('deferred.json');
    const items = (data?.items ?? []).filter(d => !d.resolved);
    if (items.length > 0) {
      lines.push(`## Deferred Items (${items.length} open)`, '');
      for (const d of items) {
        lines.push(formatDeferred(d));
      }
      lines.push('');
    }
    structured.deferredItems = items;
  }

  // Show team runs in "all" or "team-runs" view
  if (queryType === 'all' || queryType === 'team-runs') {
    const data = loadJson<{ runs: TeamRun[] }>('team-runs.json');
    const runs = data?.runs ?? [];
    if (runs.length > 0) {
      const displayRuns = depth === 'full' ? runs : runs.slice(-5);
      lines.push(`## Team Runs (${runs.length} total, showing ${depth === 'full' ? 'all' : `last ${displayRuns.length}`})`, '');
      for (const r of displayRuns) {
        lines.push(formatTeamRun(r));
      }
      lines.push('');
    }
    structured.teamRuns = runs;
  }

  logger.info('Knowledge queried', { type: queryType });
  return { text: lines.join('\n'), structured };
}
