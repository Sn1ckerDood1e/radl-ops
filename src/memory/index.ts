/**
 * Memory System - Persistent Context for Radl Ops
 *
 * Based on OpenClaw's successful memory pattern but with:
 * - Structured storage (not just freeform markdown)
 * - Importance scoring for relevance
 * - Automatic expiration for stale context
 * - Query capabilities for retrieval
 *
 * Storage: JSON Lines files organized by type
 */

import * as fs from 'fs';
import * as path from 'path';
import type { MemoryEntry, MemoryQuery } from '../types/index.js';
import { logger } from '../config/logger.js';

const MEMORY_DIR = process.env.MEMORY_DIR || './memory';
const MEMORY_FILE = path.join(MEMORY_DIR, 'memories.jsonl');
const INDEX_FILE = path.join(MEMORY_DIR, 'index.json');

interface MemoryIndex {
  byType: Record<string, string[]>;
  byTag: Record<string, string[]>;
  lastUpdated: string;
}

// In-memory cache for faster queries
let memoryCache: Map<string, MemoryEntry> = new Map();
let indexCache: MemoryIndex | null = null;

/**
 * Initialize memory system
 */
export function initMemory(): void {
  ensureMemoryDir();
  loadMemoryCache();
  logger.info('Memory system initialized', { entries: memoryCache.size });
}

/**
 * Ensure memory directory exists
 */
function ensureMemoryDir(): void {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

/**
 * Load memories into cache
 */
function loadMemoryCache(): void {
  memoryCache.clear();

  if (!fs.existsSync(MEMORY_FILE)) {
    return;
  }

  try {
    const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as MemoryEntry;
        // Skip expired entries
        if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
          continue;
        }
        memoryCache.set(entry.id, entry);
      } catch {
        // Skip malformed lines
      }
    }

    rebuildIndex();
  } catch (error) {
    logger.error('Failed to load memory cache', { error });
  }
}

/**
 * Rebuild the index for fast lookups
 */
function rebuildIndex(): void {
  indexCache = {
    byType: {},
    byTag: {},
    lastUpdated: new Date().toISOString(),
  };

  for (const [id, entry] of memoryCache) {
    // Index by type
    if (!indexCache.byType[entry.type]) {
      indexCache.byType[entry.type] = [];
    }
    indexCache.byType[entry.type].push(id);

    // Index by tags
    for (const tag of entry.tags) {
      if (!indexCache.byTag[tag]) {
        indexCache.byTag[tag] = [];
      }
      indexCache.byTag[tag].push(id);
    }
  }

  // Save index
  fs.writeFileSync(INDEX_FILE, JSON.stringify(indexCache, null, 2));
}

/**
 * Generate unique memory ID
 */
function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `mem_${timestamp}_${random}`;
}

/**
 * Save a memory entry
 */
export function remember(
  type: MemoryEntry['type'],
  content: string,
  options: {
    tags?: string[];
    importance?: number;
    expiresInDays?: number;
    source: {
      channel: string;
      conversationId: string;
    };
  }
): MemoryEntry {
  ensureMemoryDir();

  const now = new Date();
  const entry: MemoryEntry = {
    id: generateId(),
    type,
    content,
    tags: options.tags || [],
    createdAt: now,
    updatedAt: now,
    source: options.source,
    importance: options.importance ?? 5, // Default medium importance
    expiresAt: options.expiresInDays
      ? new Date(now.getTime() + options.expiresInDays * 24 * 60 * 60 * 1000)
      : undefined,
  };

  // Add to cache
  memoryCache.set(entry.id, entry);

  // Persist
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(MEMORY_FILE, line);

  // Update index
  rebuildIndex();

  logger.debug('Memory saved', { id: entry.id, type, tags: options.tags });

  return entry;
}

/**
 * Update an existing memory
 */
export function updateMemory(
  id: string,
  updates: Partial<Pick<MemoryEntry, 'content' | 'tags' | 'importance' | 'expiresAt'>>
): MemoryEntry | null {
  const existing = memoryCache.get(id);
  if (!existing) {
    return null;
  }

  const updated: MemoryEntry = {
    ...existing,
    ...updates,
    updatedAt: new Date(),
  };

  memoryCache.set(id, updated);
  persistAllMemories();

  return updated;
}

/**
 * Delete a memory
 */
export function forget(id: string): boolean {
  if (!memoryCache.has(id)) {
    return false;
  }

  memoryCache.delete(id);
  persistAllMemories();
  rebuildIndex();

  return true;
}

/**
 * Query memories
 */
export function recall(query: MemoryQuery = {}): MemoryEntry[] {
  let results = Array.from(memoryCache.values());

  // Filter by type
  if (query.types && query.types.length > 0) {
    results = results.filter(m => query.types!.includes(m.type));
  }

  // Filter by tags (any match)
  if (query.tags && query.tags.length > 0) {
    results = results.filter(m => m.tags.some(t => query.tags!.includes(t)));
  }

  // Filter by minimum importance
  if (query.minImportance !== undefined) {
    results = results.filter(m => m.importance >= query.minImportance!);
  }

  // Text search in content
  if (query.query) {
    const searchTerms = query.query.toLowerCase().split(/\s+/);
    results = results.filter(m => {
      const content = m.content.toLowerCase();
      return searchTerms.every(term => content.includes(term));
    });
  }

  // Sort by importance (descending), then by recency
  results.sort((a, b) => {
    if (a.importance !== b.importance) {
      return b.importance - a.importance;
    }
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  // Apply limit
  if (query.limit) {
    results = results.slice(0, query.limit);
  }

  return results;
}

/**
 * Get memories relevant to a topic (for injecting into context)
 */
export function getRelevantContext(
  topic: string,
  limit: number = 5
): string {
  // Get high-importance facts and preferences
  const relevant = recall({
    types: ['fact', 'preference', 'context'],
    minImportance: 6,
    query: topic,
    limit,
  });

  if (relevant.length === 0) {
    return '';
  }

  const lines = relevant.map(m => `- [${m.type}] ${m.content}`);
  return `## Relevant Context\n${lines.join('\n')}`;
}

/**
 * Get active reminders
 */
export function getActiveReminders(): MemoryEntry[] {
  return recall({
    types: ['reminder'],
    minImportance: 5,
  }).filter(m => !m.expiresAt || new Date(m.expiresAt) > new Date());
}

/**
 * Get pending tasks
 */
export function getPendingTasks(): MemoryEntry[] {
  return recall({
    types: ['task'],
    minImportance: 1,
  });
}

// ============================================
// Statistics and Management
// ============================================

/**
 * Get memory statistics
 */
export function getMemoryStats(): {
  total: number;
  byType: Record<string, number>;
  averageImportance: number;
  oldestEntry: Date | null;
  newestEntry: Date | null;
} {
  const entries = Array.from(memoryCache.values());

  if (entries.length === 0) {
    return {
      total: 0,
      byType: {},
      averageImportance: 0,
      oldestEntry: null,
      newestEntry: null,
    };
  }

  const byType: Record<string, number> = {};
  let totalImportance = 0;
  let oldest = entries[0].createdAt;
  let newest = entries[0].createdAt;

  for (const entry of entries) {
    byType[entry.type] = (byType[entry.type] || 0) + 1;
    totalImportance += entry.importance;

    const created = new Date(entry.createdAt);
    if (created < new Date(oldest)) oldest = entry.createdAt;
    if (created > new Date(newest)) newest = entry.createdAt;
  }

  return {
    total: entries.length,
    byType,
    averageImportance: totalImportance / entries.length,
    oldestEntry: new Date(oldest),
    newestEntry: new Date(newest),
  };
}

/**
 * Clean up expired memories
 */
export function cleanupExpired(): number {
  const now = new Date();
  let cleaned = 0;

  for (const [id, entry] of memoryCache) {
    if (entry.expiresAt && new Date(entry.expiresAt) < now) {
      memoryCache.delete(id);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    persistAllMemories();
    rebuildIndex();
    logger.info('Cleaned up expired memories', { count: cleaned });
  }

  return cleaned;
}

/**
 * Persist all memories (full rewrite)
 */
function persistAllMemories(): void {
  ensureMemoryDir();

  const lines = Array.from(memoryCache.values())
    .map(entry => JSON.stringify(entry))
    .join('\n');

  fs.writeFileSync(MEMORY_FILE, lines + '\n');
}

// ============================================
// Markdown Export (OpenClaw-style)
// ============================================

/**
 * Export memories as Markdown (human-readable, OpenClaw-compatible)
 */
export function exportAsMarkdown(): string {
  const sections: Record<string, MemoryEntry[]> = {};

  for (const entry of memoryCache.values()) {
    if (!sections[entry.type]) {
      sections[entry.type] = [];
    }
    sections[entry.type].push(entry);
  }

  const lines: string[] = [
    '# Radl Ops Memory',
    '',
    `> Last updated: ${new Date().toISOString()}`,
    `> Total entries: ${memoryCache.size}`,
    '',
  ];

  for (const [type, entries] of Object.entries(sections)) {
    lines.push(`## ${type.charAt(0).toUpperCase() + type.slice(1)}s`);
    lines.push('');

    const sorted = entries.sort((a, b) => b.importance - a.importance);
    for (const entry of sorted) {
      const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
      const importance = '★'.repeat(Math.min(entry.importance, 10));
      lines.push(`- ${entry.content}${tags} ${importance}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Save memory export to file
 */
export function saveMarkdownExport(): void {
  const markdown = exportAsMarkdown();
  const filepath = path.join(MEMORY_DIR, 'MEMORY.md');
  fs.writeFileSync(filepath, markdown);
  logger.info('Memory exported to Markdown', { filepath });
}

// Initialize on import
initMemory();
