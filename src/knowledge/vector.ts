/**
 * Vector Search Layer for Knowledge Base
 *
 * Provides embedding-based semantic search alongside existing FTS5 BM25.
 * Uses sqlite-vec for native SQLite vector operations.
 *
 * Starts with a simple TF-IDF bag-of-words embedding (no external API).
 * Can be swapped for Voyage/OpenAI embeddings later by replacing generateEmbedding().
 */

import { logger } from '../config/logger.js';
import { getDbForGraph } from './fts-index.js';

// ============================================
// Constants
// ============================================

/** Dimensionality of TF-IDF embeddings (vocabulary size) */
const EMBEDDING_DIM = 768;

/** Top terms to keep in the vocabulary */
const VOCAB_SIZE = EMBEDDING_DIM;

// ============================================
// Types
// ============================================

export interface VectorSearchResult {
  id: string;
  distance: number;
  score: number;
}

// ============================================
// Vocabulary (TF-IDF)
// ============================================

let vocabulary: string[] | null = null;
let idfWeights: Map<string, number> | null = null;

/**
 * Tokenize text into lowercase terms, stripping punctuation.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

/**
 * Build vocabulary from a corpus of documents.
 * Selects top VOCAB_SIZE terms by document frequency.
 */
export function buildVocabulary(documents: string[]): void {
  if (documents.length === 0) {
    logger.warn('buildVocabulary called with empty corpus — vocabulary not built');
    return;
  }

  const docFreq = new Map<string, number>();
  const totalDocs = documents.length;

  for (const doc of documents) {
    const uniqueTerms = new Set(tokenize(doc));
    for (const term of uniqueTerms) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  // Sort by frequency descending, take top VOCAB_SIZE
  const sorted = [...docFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, VOCAB_SIZE);

  // Build into local variables, then atomically assign
  const newVocabulary = sorted.map(([term]) => term);
  const newIdfWeights = new Map<string, number>();
  for (const [term, df] of sorted) {
    newIdfWeights.set(term, Math.log(Math.max(1, totalDocs) / df));
  }

  // Atomic assignment
  vocabulary = newVocabulary;
  idfWeights = newIdfWeights;

  logger.info('Vector vocabulary built', {
    totalTerms: docFreq.size,
    vocabSize: vocabulary.length,
    totalDocs,
  });
}

/**
 * Generate a TF-IDF embedding for a text string.
 * Returns a Float32Array of EMBEDDING_DIM dimensions.
 *
 * Pluggable: replace this function with an API call to Voyage/OpenAI
 * for higher-quality embeddings.
 */
export function generateEmbedding(text: string): Float32Array {
  if (!vocabulary || !idfWeights) {
    throw new Error('Vocabulary not built. Call buildVocabulary() first.');
  }

  const tokens = tokenize(text);
  const embedding = new Float32Array(EMBEDDING_DIM);

  // Term frequency
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }

  // TF-IDF vector
  for (let i = 0; i < vocabulary.length; i++) {
    const term = vocabulary[i];
    const termFreq = tf.get(term) ?? 0;
    const idf = idfWeights.get(term) ?? 0;
    embedding[i] = termFreq * idf;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < embedding.length; i++) {
    norm += embedding[i] * embedding[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] /= norm;
    }
  }

  return embedding;
}

// ============================================
// Database Operations
// ============================================

/**
 * Initialize the vec0 virtual table for vector search.
 * Must be called after sqlite-vec extension is loaded.
 */
export function initVecTable(): void {
  const db = getDbForGraph();
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(
      embedding float[${EMBEDDING_DIM}]
    );
  `);

  // Metadata table to map integer rowids to knowledge entry IDs.
  // Uses AUTOINCREMENT to guarantee monotonic integer IDs that
  // sqlite-vec's vec0 virtual table requires.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vec_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT NOT NULL UNIQUE
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vec_metadata_entry ON vec_metadata(entry_id);
  `);
}

/**
 * Convert a Float32Array embedding to a Buffer for sqlite-vec binding.
 */
function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Upsert an embedding for a knowledge entry.
 */
export function upsertEmbedding(id: string, embedding: Float32Array): void {
  const db = getDbForGraph();
  const buf = embeddingToBuffer(embedding);

  // Check if entry already exists
  const existing = db.prepare(
    'SELECT id FROM vec_metadata WHERE entry_id = ?'
  ).get(id) as { id: number } | undefined;

  if (existing) {
    const rid = BigInt(existing.id);
    // Delete old vector and re-insert
    db.prepare('DELETE FROM vec_items WHERE rowid = ?').run(rid);
    db.prepare('INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)').run(rid, buf);
  } else {
    // Insert metadata first to get an integer id.
    // sqlite-vec requires BigInt for rowid params — JS number is rejected.
    const result = db.prepare('INSERT INTO vec_metadata (entry_id) VALUES (?)').run(id);
    const rid = BigInt(result.lastInsertRowid);
    db.prepare('INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)').run(rid, buf);
  }
}

/**
 * Search for similar vectors using KNN.
 * Returns entries sorted by distance (lower = more similar).
 */
export function searchByVector(
  queryVec: Float32Array,
  limit: number = 10,
): VectorSearchResult[] {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
  const db = getDbForGraph();

  try {
    // sqlite-vec vec0 KNN queries cannot be JOINed — the LIMIT is lost
    // in the query plan. Two-step: search vectors, then lookup metadata.
    const vecRows = db.prepare(`
      SELECT rowid, distance
      FROM vec_items
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(embeddingToBuffer(queryVec), safeLimit) as Array<{
      rowid: number;
      distance: number;
    }>;

    if (vecRows.length === 0) return [];

    // Batch lookup entry_ids from metadata
    const placeholders = vecRows.map(() => '?').join(',');
    const metaRows = db.prepare(
      `SELECT id, entry_id FROM vec_metadata WHERE id IN (${placeholders})`
    ).all(...vecRows.map(r => r.rowid)) as Array<{
      id: number;
      entry_id: string;
    }>;

    const metaMap = new Map(metaRows.map(m => [m.id, m.entry_id]));

    return vecRows
      .filter(row => metaMap.has(row.rowid))
      .map(row => ({
        id: metaMap.get(row.rowid)!,
        distance: row.distance,
        // Convert distance to a 0-1 similarity score (1 = most similar)
        score: Math.max(0, 1 - row.distance),
      }));
  } catch (error) {
    logger.warn('Vector search failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Index all knowledge entries from FTS5 into the vector store.
 * Builds vocabulary from all documents, then generates and stores embeddings.
 */
export function indexAllKnowledge(): number {
  const db = getDbForGraph();

  // Load all text from FTS5 index
  const rows = db.prepare(
    'SELECT id, text FROM knowledge_fts'
  ).all() as Array<{ id: string; text: string }>;

  if (rows.length === 0) {
    logger.info('No knowledge entries to vectorize');
    return 0;
  }

  // Build vocabulary from corpus
  const documents = rows.map(r => r.text);
  buildVocabulary(documents);

  // Clear existing vectors
  db.exec('DELETE FROM vec_items');
  db.exec('DELETE FROM vec_metadata');

  // Batch insert embeddings
  const insertMeta = db.prepare('INSERT INTO vec_metadata (entry_id) VALUES (?)');
  const insertVec = db.prepare('INSERT INTO vec_items(rowid, embedding) VALUES (?, ?)');

  const batchInsert = db.transaction((items: Array<{ id: string; text: string }>) => {
    for (const item of items) {
      const embedding = generateEmbedding(item.text);
      const result = insertMeta.run(item.id);
      const rid = BigInt(result.lastInsertRowid);
      insertVec.run(rid, embeddingToBuffer(embedding));
    }
  });

  batchInsert(rows);

  logger.info('Vector index built', {
    entryCount: rows.length,
    dimensions: EMBEDDING_DIM,
  });

  return rows.length;
}

/**
 * Check if the vector index has data.
 */
export function isVecAvailable(): boolean {
  try {
    const db = getDbForGraph();
    const row = db.prepare('SELECT count(*) as cnt FROM vec_items').get() as { cnt: number };
    return row.cnt > 0;
  } catch {
    return false;
  }
}

/**
 * Check if the vocabulary is loaded (needed for generateEmbedding).
 */
export function isVocabularyReady(): boolean {
  return vocabulary !== null && idfWeights !== null;
}

/**
 * Get vector index statistics.
 */
export function getVecStats(): { count: number; dimensions: number } {
  try {
    const db = getDbForGraph();
    const row = db.prepare('SELECT count(*) as cnt FROM vec_items').get() as { cnt: number };
    return { count: row.cnt, dimensions: EMBEDDING_DIM };
  } catch {
    return { count: 0, dimensions: EMBEDDING_DIM };
  }
}
