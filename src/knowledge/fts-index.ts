/**
 * FTS5 Knowledge Search Index
 *
 * SQLite FTS5 full-text search with BM25 ranking for the knowledge base.
 * Provides dramatically better search quality than naive keyword matching.
 *
 * Uses better-sqlite3 for synchronous, zero-overhead SQLite access.
 * The database is stored at {knowledgeDir}/knowledge.db and is rebuilt
 * on demand from the JSON knowledge files.
 *
 * Embedding-ready interface: vectorScore and vectorWeight are defined
 * but not yet active. When embeddings are added, both FTS5 and vector
 * scores can be combined via combinedScore.
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../config/paths.js';
import { logger } from '../config/logger.js';

// ============================================
// Types
// ============================================

export interface SearchResult {
  id: string;
  source: string;
  sourceId: number;
  text: string;
  date: string;
  ftsScore: number;
  vectorScore?: number;
  combinedScore: number;
}

export interface SearchOptions {
  query: string;
  maxResults?: number;
  ftsWeight?: number;
  vectorWeight?: number;
  timeDecayHalfLife?: number;
}

interface KnowledgeEntry {
  source: string;
  sourceId: number;
  text: string;
  date: string;
}

// ============================================
// Constants
// ============================================

const DB_FILENAME = 'knowledge.db';
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_FTS_WEIGHT = 1.0;
const DEFAULT_VECTOR_WEIGHT = 0.0;
const DEFAULT_HALF_LIFE_DAYS = 30;

// ============================================
// Database Management
// ============================================

let dbInstance: Database.Database | null = null;

function getDbPath(): string {
  return join(getConfig().knowledgeDir, DB_FILENAME);
}

/**
 * Get or create the database connection.
 * Creates the FTS5 virtual table if it doesn't exist.
 */
function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const dbPath = getDbPath();
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  // Create FTS5 virtual table if it doesn't exist
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      text,
      id UNINDEXED,
      source UNINDEXED,
      source_id UNINDEXED,
      date UNINDEXED
    );
  `);

  // Retrieval tracking table for usage-based knowledge promotion
  db.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_counts (
      entry_id TEXT PRIMARY KEY,
      count INTEGER DEFAULT 0,
      last_retrieved_at TEXT
    );
  `);

  dbInstance = db;
  return db;
}

/**
 * Close the database connection.
 * Call this during graceful shutdown.
 */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// ============================================
// Time Decay
// ============================================

/**
 * Exponential time decay with configurable half-life.
 * Floor at 0.2 to prevent old but valuable knowledge from disappearing.
 */
function timeDecay(dateStr: string, halfLifeDays: number): number {
  const ageDays = (Date.now() - new Date(dateStr).getTime()) / 86_400_000;
  if (ageDays < 0) return 1.0; // Future dates get full weight
  return Math.max(0.2, Math.exp(-0.693 * ageDays / halfLifeDays));
}

// ============================================
// Index Management
// ============================================

/**
 * Load all knowledge entries from JSON files.
 * Combines patterns, lessons, decisions, and deferred items.
 */
function loadAllEntries(): KnowledgeEntry[] {
  const knowledgeDir = getConfig().knowledgeDir;
  const entries: KnowledgeEntry[] = [];

  // Patterns
  const patternsPath = join(knowledgeDir, 'patterns.json');
  if (existsSync(patternsPath)) {
    try {
      const data = JSON.parse(readFileSync(patternsPath, 'utf-8'));
      for (const p of data.patterns ?? []) {
        entries.push({
          source: 'pattern',
          sourceId: p.id ?? 0,
          text: `${p.name ?? ''} ${p.description ?? ''} ${p.example ?? ''}`.trim(),
          date: p.date ?? new Date().toISOString(),
        });
      }
    } catch { /* skip corrupted file */ }
  }

  // Lessons
  const lessonsPath = join(knowledgeDir, 'lessons.json');
  if (existsSync(lessonsPath)) {
    try {
      const data = JSON.parse(readFileSync(lessonsPath, 'utf-8'));
      for (const l of data.lessons ?? []) {
        entries.push({
          source: 'lesson',
          sourceId: l.id ?? 0,
          text: `${l.situation ?? ''} ${l.learning ?? ''}`.trim(),
          date: l.date ?? new Date().toISOString(),
        });
      }
    } catch { /* skip corrupted file */ }
  }

  // Decisions
  const decisionsPath = join(knowledgeDir, 'decisions.json');
  if (existsSync(decisionsPath)) {
    try {
      const data = JSON.parse(readFileSync(decisionsPath, 'utf-8'));
      for (const d of data.decisions ?? []) {
        entries.push({
          source: 'decision',
          sourceId: d.id ?? 0,
          text: `${d.title ?? ''} ${d.context ?? ''} ${d.rationale ?? ''} ${d.alternatives ?? ''}`.trim(),
          date: d.date ?? new Date().toISOString(),
        });
      }
    } catch { /* skip corrupted file */ }
  }

  // Deferred items
  const deferredPath = join(knowledgeDir, 'deferred.json');
  if (existsSync(deferredPath)) {
    try {
      const data = JSON.parse(readFileSync(deferredPath, 'utf-8'));
      for (const d of data.items ?? []) {
        entries.push({
          source: 'deferred',
          sourceId: d.id ?? 0,
          text: `${d.title ?? ''} ${d.reason ?? ''} ${d.effort ?? ''}`.trim(),
          date: d.date ?? new Date().toISOString(),
        });
      }
    } catch { /* skip corrupted file */ }
  }

  return entries;
}

/**
 * Rebuild the FTS5 index from scratch using all knowledge JSON files.
 * Safe to call multiple times — clears and repopulates.
 */
export function rebuildIndex(): number {
  const db = getDb();
  const entries = loadAllEntries();

  // Clear existing data
  db.exec('DELETE FROM knowledge_fts');

  // Insert all entries
  const insert = db.prepare(
    'INSERT INTO knowledge_fts (text, id, source, source_id, date) VALUES (?, ?, ?, ?, ?)'
  );

  const insertMany = db.transaction((items: KnowledgeEntry[]) => {
    for (const entry of items) {
      const id = `${entry.source}-${entry.sourceId}`;
      insert.run(entry.text, id, entry.source, entry.sourceId, entry.date);
    }
  });

  insertMany(entries);

  logger.info('FTS5 index rebuilt', { entryCount: entries.length });
  return entries.length;
}

/**
 * Upsert a single entry into the FTS5 index.
 * Used by compound.ts after merging new knowledge.
 */
export function upsertEntry(entry: KnowledgeEntry): void {
  const db = getDb();
  const id = `${entry.source}-${entry.sourceId}`;

  // Delete existing entry if present (FTS5 doesn't have UPDATE)
  db.prepare('DELETE FROM knowledge_fts WHERE id = ?').run(id);

  // Insert new/updated entry
  db.prepare(
    'INSERT INTO knowledge_fts (text, id, source, source_id, date) VALUES (?, ?, ?, ?, ?)'
  ).run(entry.text, id, entry.source, entry.sourceId, entry.date);
}

/**
 * Initialize the FTS5 index if the database doesn't exist or is empty.
 * Call this at server startup.
 */
export function initFtsIndex(): void {
  const dbPath = getDbPath();
  const isNew = !existsSync(dbPath);

  getDb(); // Ensures table is created

  if (isNew) {
    const count = rebuildIndex();
    logger.info('FTS5 index initialized from scratch', { entryCount: count });
  } else {
    // Check if index has data
    const db = getDb();
    const row = db.prepare('SELECT count(*) as cnt FROM knowledge_fts').get() as { cnt: number };
    if (row.cnt === 0) {
      const count = rebuildIndex();
      logger.info('FTS5 index was empty, rebuilt', { entryCount: count });
    } else {
      logger.info('FTS5 index loaded', { entryCount: row.cnt });
    }
  }
}

// ============================================
// Search
// ============================================

/**
 * Sanitize a user-supplied query string for FTS5 MATCH.
 * Strips FTS5 metacharacters that could cause parse errors or wildcard DoS.
 * Joins remaining tokens with OR for multi-word queries.
 */
function sanitizeFtsQuery(raw: string): string {
  // Strip FTS5 special characters: quotes, wildcards, negation, grouping, column prefix
  const stripped = raw.replace(/["*\-^():]/g, ' ').trim();
  if (!stripped) return '';
  // Join tokens with OR for broad matching
  return stripped.split(/\s+/).filter(Boolean).join(' OR ');
}

/**
 * Search the FTS5 index using BM25 ranking with optional time decay.
 *
 * Returns results sorted by combined score (FTS5 BM25 * time decay).
 * The vectorScore field is reserved for future embedding-based search.
 */
export function searchFts(options: SearchOptions): SearchResult[] {
  const {
    query,
    maxResults = DEFAULT_MAX_RESULTS,
    ftsWeight = DEFAULT_FTS_WEIGHT,
    vectorWeight = DEFAULT_VECTOR_WEIGHT,
    timeDecayHalfLife = DEFAULT_HALF_LIFE_DAYS,
  } = options;

  if (!query.trim()) return [];

  // Sanitize query for FTS5 — strip metacharacters that could cause parse errors or DoS
  const safeQuery = sanitizeFtsQuery(query);
  if (!safeQuery) return [];

  const db = getDb();

  // FTS5 match query with BM25 ranking
  // bm25() returns negative values (lower = better match), so we negate it
  let rows: Array<{
    text: string;
    id: string;
    source: string;
    source_id: number;
    date: string;
    fts_score: number;
  }>;
  try {
    rows = db.prepare(`
      SELECT
        text,
        id,
        source,
        source_id,
        date,
        -bm25(knowledge_fts) as fts_score
      FROM knowledge_fts
      WHERE knowledge_fts MATCH ?
      ORDER BY fts_score DESC
      LIMIT ?
    `).all(safeQuery, maxResults * 3) as typeof rows;
  } catch (error) {
    // FTS5 query syntax can still fail on edge cases — return empty instead of crashing
    logger.warn('FTS5 query failed, returning empty results', {
      query,
      safeQuery,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  // Apply time decay and compute combined scores
  const results: SearchResult[] = rows.map(row => {
    const decay = timeDecay(row.date, timeDecayHalfLife);
    const ftsScore = row.fts_score * decay;
    const combinedScore = ftsScore * ftsWeight + (0) * vectorWeight;

    return {
      id: row.id,
      source: row.source,
      sourceId: row.source_id,
      text: row.text,
      date: row.date,
      ftsScore,
      combinedScore,
    };
  });

  // Re-sort by combined score (time decay may change ordering)
  const sorted = [...results]
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, maxResults);

  logger.info('FTS5 search complete', {
    query,
    totalMatches: rows.length,
    returned: sorted.length,
  });

  return sorted;
}

/**
 * Check if the FTS5 index is available and has data.
 * Used by knowledge.ts to decide whether to use FTS5 or fallback.
 */
export function isFtsAvailable(): boolean {
  try {
    const db = getDb();
    const row = db.prepare('SELECT count(*) as cnt FROM knowledge_fts').get() as { cnt: number };
    return row.cnt > 0;
  } catch {
    return false;
  }
}

// ============================================
// Retrieval Tracking & Knowledge Promotion
// ============================================

const PROMOTION_THRESHOLD = 3;
const STALE_DAYS = 60;

/**
 * Record a retrieval for one or more knowledge entry IDs.
 * Called by knowledge_query after returning search results.
 */
export function recordRetrievals(entryIds: string[]): void {
  if (entryIds.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();

  const upsert = db.prepare(`
    INSERT INTO retrieval_counts (entry_id, count, last_retrieved_at)
    VALUES (?, 1, ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      count = count + 1,
      last_retrieved_at = ?
  `);

  const batchUpsert = db.transaction((ids: string[]) => {
    for (const id of ids) {
      upsert.run(id, now, now);
    }
  });

  batchUpsert(entryIds);
}

export interface PromotionCandidate {
  entryId: string;
  count: number;
  lastRetrieved: string;
}

/**
 * Find knowledge entries that have been retrieved >= PROMOTION_THRESHOLD times.
 * These are candidates for crystallization (crystallize_propose).
 */
export function getPromotionCandidates(): PromotionCandidate[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT entry_id, count, last_retrieved_at
    FROM retrieval_counts
    WHERE count >= ?
    ORDER BY count DESC
  `).all(PROMOTION_THRESHOLD) as Array<{
    entry_id: string;
    count: number;
    last_retrieved_at: string;
  }>;

  return rows.map(r => ({
    entryId: r.entry_id,
    count: r.count,
    lastRetrieved: r.last_retrieved_at,
  }));
}

/**
 * Find knowledge entries with 0 retrievals in the last STALE_DAYS.
 * These are candidates for archival.
 */
export function getStaleEntries(): PromotionCandidate[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();

  // Entries in FTS5 with no retrieval record OR last retrieved before cutoff
  const rows = db.prepare(`
    SELECT f.id as entry_id,
           COALESCE(r.count, 0) as count,
           COALESCE(r.last_retrieved_at, f.date) as last_retrieved_at
    FROM knowledge_fts f
    LEFT JOIN retrieval_counts r ON r.entry_id = f.id
    WHERE r.entry_id IS NULL
       OR (r.count = 0 AND r.last_retrieved_at < ?)
       OR (r.last_retrieved_at < ? AND r.count < 2)
    ORDER BY last_retrieved_at ASC
    LIMIT 20
  `).all(cutoff, cutoff) as Array<{
    entry_id: string;
    count: number;
    last_retrieved_at: string;
  }>;

  return rows.map(r => ({
    entryId: r.entry_id,
    count: r.count,
    lastRetrieved: r.last_retrieved_at,
  }));
}
