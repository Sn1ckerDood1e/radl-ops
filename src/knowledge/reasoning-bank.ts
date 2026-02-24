/**
 * ReasoningBank — Cache distilled knowledge context by task description hash.
 *
 * When sprint_conductor loads knowledge for a feature, the assembled context
 * (patterns, lessons, deferred items, estimations) is cached by a normalized
 * hash of the feature description. If a similar task was planned before,
 * reuse the cached context instead of re-loading all JSON files.
 *
 * Cache entries invalidate when source knowledge files change (tracked by
 * file modification timestamps).
 *
 * Storage: knowledge/reasoning-bank.json
 */

import { readFileSync, writeFileSync, existsSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { getConfig } from '../config/paths.js';
import { logger } from '../config/logger.js';

// ============================================
// Types
// ============================================

export interface CachedReasoning {
  key: string;
  featureNormalized: string;
  context: string;
  sourceHashes: Record<string, number>; // filename -> mtime
  cachedAt: string;
  hits: number;
}

interface ReasoningBankStore {
  entries: CachedReasoning[];
}

// ============================================
// Constants
// ============================================

const BANK_FILENAME = 'reasoning-bank.json';
const MAX_ENTRIES = 50;
const KNOWLEDGE_FILES = ['patterns.json', 'lessons.json', 'decisions.json', 'deferred.json'];

// ============================================
// File I/O
// ============================================

function getBankPath(): string {
  return join(getConfig().knowledgeDir, BANK_FILENAME);
}

function loadBank(): ReasoningBankStore {
  const path = getBankPath();
  if (!existsSync(path)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ReasoningBankStore;
  } catch {
    return { entries: [] };
  }
}

function saveBank(bank: ReasoningBankStore): void {
  const targetPath = getBankPath();
  const tmpPath = `${targetPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(bank, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, targetPath);
}

// ============================================
// Hashing & Normalization
// ============================================

/**
 * Normalize a feature description for hash key generation.
 * Lowercases, removes stopwords, sorts remaining tokens.
 */
function normalizeFeature(feature: string): string {
  const stopwords = new Set([
    'the', 'a', 'an', 'is', 'in', 'to', 'of', 'and', 'for', 'with',
    'on', 'at', 'by', 'it', 'or', 'be', 'as', 'do', 'add', 'implement',
    'create', 'build', 'make', 'update', 'fix', 'new',
  ]);

  const tokens = feature
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !stopwords.has(t))
    .sort();

  return tokens.join(' ');
}

function hashFeature(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex').substring(0, 16);
}

/**
 * Get modification timestamps for knowledge source files.
 * Used to detect when cached context is stale.
 */
function getSourceHashes(): Record<string, number> {
  const knowledgeDir = getConfig().knowledgeDir;
  const hashes: Record<string, number> = {};

  for (const filename of KNOWLEDGE_FILES) {
    const filePath = join(knowledgeDir, filename);
    if (existsSync(filePath)) {
      hashes[filename] = statSync(filePath).mtimeMs;
    }
  }

  return hashes;
}

/**
 * Check if cached source hashes match current file timestamps.
 */
function isStale(cached: Record<string, number>, current: Record<string, number>): boolean {
  for (const [file, mtime] of Object.entries(current)) {
    if (cached[file] !== mtime) return true;
  }
  // Also stale if a file was removed
  for (const file of Object.keys(cached)) {
    if (!(file in current)) return true;
  }
  return false;
}

// ============================================
// Public API
// ============================================

/**
 * Look up cached knowledge context for a feature description.
 * Returns the cached context string if found and not stale, or null.
 */
export function getCachedContext(feature: string): string | null {
  const normalized = normalizeFeature(feature);
  const key = hashFeature(normalized);
  const bank = loadBank();
  const currentHashes = getSourceHashes();

  const entry = bank.entries.find(e => e.key === key);
  if (!entry) return null;

  // Check if source files have changed since caching
  if (isStale(entry.sourceHashes, currentHashes)) {
    // Remove stale entry
    bank.entries = bank.entries.filter(e => e.key !== key);
    saveBank(bank);
    logger.info('ReasoningBank: stale entry evicted', { key, feature: normalized });
    return null;
  }

  // Cache hit — increment counter
  const updatedEntries = bank.entries.map(e =>
    e.key === key ? { ...e, hits: e.hits + 1 } : e
  );
  saveBank({ entries: updatedEntries });

  logger.info('ReasoningBank: cache hit', { key, hits: entry.hits + 1 });
  return entry.context;
}

/**
 * Cache knowledge context for a feature description.
 * Evicts oldest entries if the bank exceeds MAX_ENTRIES.
 */
export function cacheContext(feature: string, context: string): void {
  const normalized = normalizeFeature(feature);
  const key = hashFeature(normalized);
  const bank = loadBank();
  const currentHashes = getSourceHashes();

  // Remove existing entry with same key (upsert)
  const filtered = bank.entries.filter(e => e.key !== key);

  const newEntry: CachedReasoning = {
    key,
    featureNormalized: normalized,
    context,
    sourceHashes: currentHashes,
    cachedAt: new Date().toISOString(),
    hits: 0,
  };

  filtered.push(newEntry);

  // Evict oldest if over limit (keep most recently cached)
  const sorted = filtered.sort(
    (a, b) => new Date(b.cachedAt).getTime() - new Date(a.cachedAt).getTime()
  );
  const trimmed = sorted.slice(0, MAX_ENTRIES);

  saveBank({ entries: trimmed });
  logger.info('ReasoningBank: context cached', { key, contextLength: context.length });
}

/**
 * Get bank statistics for diagnostics.
 */
export function getBankStats(): { entries: number; totalHits: number; oldestEntry: string | null } {
  const bank = loadBank();
  const totalHits = bank.entries.reduce((sum, e) => sum + e.hits, 0);
  const oldest = bank.entries.length > 0
    ? bank.entries.reduce((a, b) => a.cachedAt < b.cachedAt ? a : b).cachedAt
    : null;

  return { entries: bank.entries.length, totalHits, oldestEntry: oldest };
}

/**
 * Clear the entire reasoning bank.
 */
export function clearBank(): void {
  saveBank({ entries: [] });
  logger.info('ReasoningBank: cleared');
}
