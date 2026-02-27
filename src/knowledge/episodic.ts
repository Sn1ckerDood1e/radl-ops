/**
 * Episodic Memory Layer
 *
 * Lightweight session-level memory that persists key decisions within sprints.
 * Gives future sprints access to "what happened last time we tried X" without
 * waiting for the full Bloom pipeline extraction.
 *
 * Storage: FTS5 table in the existing knowledge SQLite database.
 * Rotation: entries older than 90 days are automatically pruned on init.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { logger } from '../config/logger.js';
import { withErrorTracking } from '../mcp/with-error-tracking.js';
import { getConfig } from '../config/paths.js';

// ============================================
// Types
// ============================================

export interface Episode {
  id: number;
  sprintPhase: string;
  timestamp: string;
  action: string;
  outcome: string;
  lesson: string | null;
  tags: string[];
}

// ============================================
// Database
// ============================================

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  const knowledgeDir = getConfig().knowledgeDir;
  if (!existsSync(knowledgeDir)) {
    mkdirSync(knowledgeDir, { recursive: true });
  }

  const dbPath = join(knowledgeDir, 'episodic.sqlite');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_phase TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      lesson TEXT,
      tags TEXT NOT NULL DEFAULT '[]'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      action, outcome, lesson, tags,
      content='episodes',
      content_rowid='id'
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
      INSERT INTO episodes_fts(rowid, action, outcome, lesson, tags)
      VALUES (new.id, new.action, new.outcome, COALESCE(new.lesson, ''), new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
      INSERT INTO episodes_fts(episodes_fts, rowid, action, outcome, lesson, tags)
      VALUES ('delete', old.id, old.action, old.outcome, COALESCE(old.lesson, ''), old.tags);
    END;
  `);

  // Prune old entries (>90 days)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const deleted = db.prepare(
    `DELETE FROM episodes WHERE timestamp < ?`
  ).run(cutoff.toISOString());

  if ((deleted.changes ?? 0) > 0) {
    logger.info('Episodic memory: pruned old entries', { deleted: deleted.changes });
  }

  return db;
}

// ============================================
// Core Functions
// ============================================

/**
 * Record an episode (key decision/action during a sprint).
 */
export function recordEpisode(
  sprintPhase: string,
  action: string,
  outcome: string,
  lesson?: string,
  tags?: string[],
): Episode {
  const database = getDb();
  const tagsJson = JSON.stringify(tags ?? []);

  const result = database.prepare(`
    INSERT INTO episodes (sprint_phase, action, outcome, lesson, tags)
    VALUES (?, ?, ?, ?, ?)
  `).run(sprintPhase, action, outcome, lesson ?? null, tagsJson);

  const episode: Episode = {
    id: Number(result.lastInsertRowid),
    sprintPhase,
    timestamp: new Date().toISOString(),
    action,
    outcome,
    lesson: lesson ?? null,
    tags: tags ?? [],
  };

  logger.debug('Episode recorded', { id: episode.id, sprintPhase, action: action.substring(0, 50) });
  return episode;
}

/**
 * Recall episodes matching a keyword query using FTS5 search.
 * Returns most recent matches first.
 */
export function recallEpisodes(
  query: string,
  limit: number = 10,
  sprintPhase?: string,
): Episode[] {
  const database = getDb();

  // Clean query for FTS5 (remove special chars, wrap tokens in quotes for exact matching)
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2);

  if (tokens.length === 0) {
    return [];
  }

  const ftsQuery = tokens.join(' OR ');

  let sql = `
    SELECT e.id, e.sprint_phase, e.timestamp, e.action, e.outcome, e.lesson, e.tags
    FROM episodes e
    JOIN episodes_fts f ON e.id = f.rowid
    WHERE episodes_fts MATCH ?
  `;
  const params: unknown[] = [ftsQuery];

  if (sprintPhase) {
    sql += ' AND e.sprint_phase = ?';
    params.push(sprintPhase);
  }

  sql += ' ORDER BY e.timestamp DESC LIMIT ?';
  params.push(limit);

  const rows = database.prepare(sql).all(...params) as Array<{
    id: number;
    sprint_phase: string;
    timestamp: string;
    action: string;
    outcome: string;
    lesson: string | null;
    tags: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    sprintPhase: row.sprint_phase,
    timestamp: row.timestamp,
    action: row.action,
    outcome: row.outcome,
    lesson: row.lesson,
    tags: safeParseTags(row.tags),
  }));
}

/**
 * Get recent episodes for a sprint phase.
 */
export function getRecentEpisodes(sprintPhase: string, limit: number = 20): Episode[] {
  const database = getDb();

  const rows = database.prepare(`
    SELECT id, sprint_phase, timestamp, action, outcome, lesson, tags
    FROM episodes
    WHERE sprint_phase = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(sprintPhase, limit) as Array<{
    id: number;
    sprint_phase: string;
    timestamp: string;
    action: string;
    outcome: string;
    lesson: string | null;
    tags: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    sprintPhase: row.sprint_phase,
    timestamp: row.timestamp,
    action: row.action,
    outcome: row.outcome,
    lesson: row.lesson,
    tags: safeParseTags(row.tags),
  }));
}

function safeParseTags(tagsStr: string): string[] {
  try {
    const parsed = JSON.parse(tagsStr);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// ============================================
// MCP Tool Registration
// ============================================

export function registerEpisodicMemoryTools(server: McpServer): void {
  server.tool(
    'record_episode',
    'Record a key decision or action during a sprint for episodic memory. Provides "what happened last time" context for future sprints. Zero cost.',
    {
      sprint_phase: z.string().describe('Current sprint phase (e.g., "Phase 125")'),
      action: z.string().min(5).describe('What action was taken (e.g., "Chose SQLite over PostgreSQL for local storage")'),
      outcome: z.string().min(5).describe('What happened as a result (e.g., "Worked well, 10ms query time, no setup needed")'),
      lesson: z.string().optional().describe('Optional lesson learned (e.g., "SQLite is sufficient for local-only analytics")'),
      tags: z.array(z.string()).optional().describe('Optional tags for categorization (e.g., ["database", "architecture"])'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    withErrorTracking('record_episode', async ({ sprint_phase, action, outcome, lesson, tags }) => {
      const episode = recordEpisode(sprint_phase, action, outcome, lesson, tags);

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Episode #${episode.id} recorded.`,
            '',
            `**Sprint:** ${episode.sprintPhase}`,
            `**Action:** ${episode.action}`,
            `**Outcome:** ${episode.outcome}`,
            episode.lesson ? `**Lesson:** ${episode.lesson}` : '',
            episode.tags.length > 0 ? `**Tags:** ${episode.tags.join(', ')}` : '',
          ].filter(Boolean).join('\n'),
        }],
      };
    }),
  );

  server.tool(
    'recall_episodes',
    'Search episodic memory for past decisions and outcomes. Uses FTS5 for fast keyword matching. Zero cost.',
    {
      query: z.string().min(2).describe('Search query (keywords matched against action, outcome, lesson)'),
      limit: z.number().int().min(1).max(50).optional().default(10)
        .describe('Maximum results (default: 10)'),
      sprint_phase: z.string().optional()
        .describe('Optional: filter to a specific sprint phase'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    withErrorTracking('recall_episodes', async ({ query, limit, sprint_phase }) => {
      const episodes = recallEpisodes(query, limit, sprint_phase);

      if (episodes.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No episodes found matching "${query}".${sprint_phase ? ` (filtered to ${sprint_phase})` : ''}`,
          }],
        };
      }

      const lines = [
        `## Episodic Memory: "${query}"`,
        '',
        `**Found:** ${episodes.length} episodes`,
        '',
      ];

      for (const ep of episodes) {
        lines.push(
          `### Episode #${ep.id} (${ep.sprintPhase})`,
          `_${ep.timestamp}_`,
          `**Action:** ${ep.action}`,
          `**Outcome:** ${ep.outcome}`,
        );
        if (ep.lesson) lines.push(`**Lesson:** ${ep.lesson}`);
        if (ep.tags.length > 0) lines.push(`**Tags:** ${ep.tags.join(', ')}`);
        lines.push('');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }),
  );
}
