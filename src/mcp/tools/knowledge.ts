/**
 * MCP Knowledge Tools - Query compound learnings
 *
 * Surfaces patterns, lessons, and decisions from the knowledge base
 * so they're available in Claude Code sessions programmatically.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { logger } from '../../config/logger.js';

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

export function registerKnowledgeTools(server: McpServer): void {
  server.tool(
    'knowledge_query',
    'Query the compound learning knowledge base. Returns patterns to apply, lessons to avoid, and past decisions. Use at session start and before making architectural choices.',
    {
      type: z.enum(['all', 'patterns', 'lessons', 'decisions']).optional()
        .describe('Type of knowledge to query (defaults to all)'),
    },
    async ({ type }) => {
      const queryType = type ?? 'all';
      const lines: string[] = [];

      if (queryType === 'all' || queryType === 'patterns') {
        const data = loadJson<{ patterns: Pattern[] }>('patterns.json');
        const patterns = data?.patterns ?? [];
        lines.push(`## Patterns (${patterns.length})`, '');
        if (patterns.length === 0) {
          lines.push('No patterns recorded yet.', '');
        } else {
          for (const p of patterns) {
            lines.push(`- **${p.name}**: ${p.description}`);
            if (p.example) lines.push(`  Example: \`${p.example}\``);
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
            lines.push(`- **Situation**: ${l.situation}`);
            lines.push(`  **Learning**: ${l.learning}`);
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
            lines.push(`- [${d.phase ?? '?'}] **${d.title}**`);
            if (d.rationale) lines.push(`  Rationale: ${d.rationale}`);
          }
          lines.push('');
        }
      }

      logger.info('Knowledge queried', { type: queryType });
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );
}
