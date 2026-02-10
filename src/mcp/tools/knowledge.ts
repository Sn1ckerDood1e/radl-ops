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

const KNOWLEDGE_DIR = '/home/hb/radl-ops/knowledge';

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

interface ScoredEntry {
  type: 'pattern' | 'lesson' | 'decision';
  score: number;
  text: string;
}

function loadJson<T>(filename: string): T | null {
  const path = `${KNOWLEDGE_DIR}/${filename}`;
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

export function registerKnowledgeTools(server: McpServer): void {
  server.tool(
    'knowledge_query',
    'Query the compound learning knowledge base. Returns patterns to apply, lessons to avoid, and past decisions. Supports keyword search. Use at session start and before making architectural choices.',
    {
      type: z.enum(['all', 'patterns', 'lessons', 'decisions']).optional()
        .describe('Type of knowledge to query (defaults to all)'),
      query: z.string().max(200).optional()
        .describe('Search keyword to filter results (searches names, descriptions, learnings, rationale)'),
    },
    withErrorTracking('knowledge_query', async ({ type, query }) => {
      const queryType = type ?? 'all';

      // If no query, return all entries (existing behavior)
      if (!query) {
        return { content: [{ type: 'text' as const, text: formatAll(queryType) }] };
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

      if (scored.length === 0) {
        logger.info('Knowledge search: no results', { query, type: queryType });
        return {
          content: [{
            type: 'text' as const,
            text: `No results for '${query}'. Try broader keywords or omit the query to see all entries.`,
          }],
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
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    })
  );
}

/**
 * Format all entries without search filtering (original behavior)
 */
function formatAll(queryType: string): string {
  const lines: string[] = [];

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
  }

  if (queryType === 'all' || queryType === 'decisions') {
    const data = loadJson<{ decisions: Decision[] }>('decisions.json');
    const decisions = data?.decisions ?? [];
    lines.push(`## Decisions (${decisions.length})`, '');
    if (decisions.length === 0) {
      lines.push('No decisions recorded yet.', '');
    } else {
      for (const d of decisions.slice(-10)) {
        lines.push(formatDecision(d));
      }
      lines.push('');
    }
  }

  logger.info('Knowledge queried', { type: queryType });
  return lines.join('\n');
}
