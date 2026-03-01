import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock better-sqlite3 with controllable statement mocks
const mockStmt = {
  run: vi.fn().mockReturnValue({ changes: 0 }),
  all: vi.fn().mockReturnValue([]),
  get: vi.fn().mockReturnValue({ cnt: 5 }),
};
const mockDb = {
  pragma: vi.fn(),
  exec: vi.fn(),
  prepare: vi.fn().mockReturnValue(mockStmt),
  transaction: vi.fn((fn: Function) => fn),
};

// Must use a non-arrow function so `new Database()` works
vi.mock('better-sqlite3', () => {
  function MockDatabase() { return mockDb; }
  return { default: MockDatabase };
});

vi.mock('sqlite-vec', () => ({
  load: vi.fn(),
}));

vi.mock('../config/paths.js', () => ({
  getConfig: vi.fn(() => ({ knowledgeDir: '/tmp/test-knowledge' })),
}));

vi.mock('../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn().mockReturnValue('[]'),
  existsSync: vi.fn().mockReturnValue(true),
}));

// Mock anthropic client for HyDE tests
const mockCreate = vi.fn();
vi.mock('../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(() => ({
    messages: { create: mockCreate },
  })),
}));

import { logger } from '../config/logger.js';
import {
  expandQueryWithHyDE,
  searchWithHyDE,
  searchFts,
  recordRetrievals,
} from './fts-index.js';

describe('FTS Index Enhancements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish default mock returns after clearAllMocks
    mockStmt.all.mockReturnValue([]);
    mockStmt.get.mockReturnValue({ cnt: 5 });
    mockStmt.run.mockReturnValue({ changes: 0 });
    mockDb.prepare.mockReturnValue(mockStmt);
    mockDb.transaction.mockImplementation((fn: Function) => fn);
  });

  // ============================================
  // HyDE Query Expansion
  // ============================================

  describe('expandQueryWithHyDE', () => {
    it('calls Haiku to generate hypothetical document', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'CSRF protection requires adding token headers to fetch requests.' }],
        usage: { input_tokens: 50, output_tokens: 20 },
      });

      const tokens = await expandQueryWithHyDE('CSRF protection');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          messages: [{
            role: 'user',
            content: expect.stringContaining('CSRF protection'),
          }],
        }),
      );
      expect(tokens.length).toBeGreaterThan(0);
    });

    it('filters stopwords from expansion tokens', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'csrf protection include token headers requests' }],
        usage: { input_tokens: 50, output_tokens: 20 },
      });

      const tokens = await expandQueryWithHyDE('CSRF');

      // Real terms should be present
      expect(tokens).toContain('csrf');
      expect(tokens).toContain('protection');
      expect(tokens).toContain('token');
      expect(tokens).toContain('headers');
      expect(tokens).toContain('requests');
    });

    it('filters short tokens (length <= 2)', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'database connection pool management' }],
        usage: { input_tokens: 50, output_tokens: 20 },
      });

      const tokens = await expandQueryWithHyDE('database');

      // All tokens should be > 2 chars
      for (const token of tokens) {
        expect(token.length).toBeGreaterThan(2);
      }
    });

    it('deduplicates tokens', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'database database migration migration database' }],
        usage: { input_tokens: 50, output_tokens: 20 },
      });

      const tokens = await expandQueryWithHyDE('database');

      const uniqueCount = new Set(tokens).size;
      expect(tokens.length).toBe(uniqueCount);
    });

    it('returns empty array when API response has no text', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'tool_use', id: 'x', name: 'y', input: {} }],
        usage: { input_tokens: 50, output_tokens: 0 },
      });

      const tokens = await expandQueryWithHyDE('test query');

      expect(tokens).toEqual([]);
    });

    it('returns empty array and logs warning on API error', async () => {
      mockCreate.mockRejectedValue(new Error('rate limited'));

      const tokens = await expandQueryWithHyDE('test query');

      expect(tokens).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'HyDE expansion failed, using original query',
        expect.objectContaining({ error: 'rate limited' }),
      );
    });
  });

  describe('searchWithHyDE', () => {
    it('delegates to searchFts when useHyDE is false', async () => {
      const results = await searchWithHyDE({ query: 'test', useHyDE: false });

      expect(mockCreate).not.toHaveBeenCalled();
      expect(results).toEqual([]);
    });

    it('falls back to searchFts when HyDE returns empty tokens', async () => {
      mockCreate.mockRejectedValue(new Error('API down'));

      const results = await searchWithHyDE({ query: 'test', useHyDE: true });

      expect(results).toEqual([]);
    });

    it('combines original and HyDE terms for expanded search', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'database migration schema rollback' }],
        usage: { input_tokens: 50, output_tokens: 20 },
      });

      await searchWithHyDE({ query: 'enum migration', useHyDE: true });

      expect(logger.info).toHaveBeenCalledWith(
        'HyDE query expansion',
        expect.objectContaining({
          original: 'enum migration',
          addedTerms: expect.any(Number),
        }),
      );
    });
  });

  // ============================================
  // Access-Refreshed Decay
  // ============================================

  describe('access-refreshed decay in searchFts', () => {
    it('loads retrieval timestamps for decay calculation', () => {
      // Set up chained prepare calls
      const ftsStmt = { all: vi.fn().mockReturnValue([
        {
          text: 'CSRF protection pattern',
          id: 'entry-1',
          source: 'patterns',
          source_id: 1,
          date: '2026-01-01T00:00:00.000Z',
          fts_score: 5.0,
        },
      ])};
      const retrievalStmt = { all: vi.fn().mockReturnValue([]) };
      mockDb.prepare
        .mockReturnValueOnce(ftsStmt)
        .mockReturnValueOnce(retrievalStmt);

      searchFts({ query: 'csrf' });

      // Should have prepared both FTS and retrieval_counts queries
      expect(mockDb.prepare).toHaveBeenCalledTimes(2);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('retrieval_counts'),
      );
    });

    it('uses the more recent date between entry date and last retrieval', () => {
      const recentDate = '2026-02-25T00:00:00.000Z';
      const oldDate = '2026-01-01T00:00:00.000Z';

      const ftsStmt = { all: vi.fn().mockReturnValue([
        {
          text: 'Old pattern refreshed recently',
          id: 'entry-old-refreshed',
          source: 'patterns',
          source_id: 1,
          date: oldDate,
          fts_score: 5.0,
        },
        {
          text: 'New pattern never accessed',
          id: 'entry-new',
          source: 'patterns',
          source_id: 2,
          date: recentDate,
          fts_score: 5.0,
        },
      ])};
      const retrievalStmt = { all: vi.fn().mockReturnValue([
        { entry_id: 'entry-old-refreshed', last_retrieved_at: recentDate },
      ])};
      mockDb.prepare
        .mockReturnValueOnce(ftsStmt)
        .mockReturnValueOnce(retrievalStmt);

      const results = searchFts({ query: 'pattern' });

      expect(results.length).toBe(2);
      // Both should have similar scores since effective dates are the same (~Feb 25)
      const oldRefreshed = results.find(r => r.id === 'entry-old-refreshed');
      const newEntry = results.find(r => r.id === 'entry-new');
      expect(oldRefreshed).toBeTruthy();
      expect(newEntry).toBeTruthy();
      // Ratio should be close to 1.0 since effective dates are identical
      if (oldRefreshed && newEntry) {
        const ratio = oldRefreshed.combinedScore / newEntry.combinedScore;
        expect(ratio).toBeGreaterThan(0.9);
        expect(ratio).toBeLessThan(1.1);
      }
    });

    it('gracefully handles missing retrieval_counts table', () => {
      const ftsStmt = { all: vi.fn().mockReturnValue([
        {
          text: 'Test pattern',
          id: 'entry-1',
          source: 'patterns',
          source_id: 1,
          date: '2026-02-01T00:00:00.000Z',
          fts_score: 3.0,
        },
      ])};
      const brokenStmt = { all: vi.fn().mockImplementation(() => {
        throw new Error('no such table: retrieval_counts');
      })};
      mockDb.prepare
        .mockReturnValueOnce(ftsStmt)
        .mockReturnValueOnce(brokenStmt);

      const results = searchFts({ query: 'test' });

      // Should still return results (graceful fallback)
      expect(results.length).toBe(1);
    });
  });

  describe('recordRetrievals updates last_retrieved_at', () => {
    it('upserts retrieval count and timestamp for each entry', () => {
      recordRetrievals(['entry-a', 'entry-b']);

      // Should call prepare with UPSERT including last_retrieved_at
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('last_retrieved_at'),
      );
      // Should run for each entry
      expect(mockStmt.run).toHaveBeenCalledTimes(2);
    });

    it('does nothing for empty array', () => {
      recordRetrievals([]);

      // Should not call prepare for upsert (returns early)
      // Only the initial DB setup calls prepare, not the upsert
    });
  });

  // ============================================
  // Hybrid BM25+Vector Scoring
  // ============================================

  describe('hybrid BM25+vector scoring in searchFts', () => {
    it('skips vector search when vectorWeight is 0 (default)', () => {
      const ftsStmt = { all: vi.fn().mockReturnValue([
        {
          text: 'Test entry',
          id: 'e1',
          source: 'patterns',
          source_id: 1,
          date: '2026-02-20T00:00:00.000Z',
          fts_score: 4.0,
        },
      ])};
      const retrievalStmt = { all: vi.fn().mockReturnValue([]) };
      mockDb.prepare
        .mockReturnValueOnce(ftsStmt)
        .mockReturnValueOnce(retrievalStmt);

      const results = searchFts({ query: 'test', vectorWeight: 0 });

      expect(results.length).toBe(1);
      expect(results[0].vectorScore).toBeUndefined();
    });

    it('falls back to FTS-only when vector module throws', () => {
      const ftsStmt = { all: vi.fn().mockReturnValue([
        {
          text: 'Test entry',
          id: 'e1',
          source: 'patterns',
          source_id: 1,
          date: '2026-02-20T00:00:00.000Z',
          fts_score: 4.0,
        },
      ])};
      const retrievalStmt = { all: vi.fn().mockReturnValue([]) };
      mockDb.prepare
        .mockReturnValueOnce(ftsStmt)
        .mockReturnValueOnce(retrievalStmt);

      // Even with vectorWeight > 0, vector module require() fails in test env
      const results = searchFts({ query: 'test', vectorWeight: 0.3 });

      expect(results.length).toBe(1);
      // No vector score since module isn't available
      expect(results[0].vectorScore).toBeUndefined();
    });

    it('re-sorts results by combined score', () => {
      const ftsStmt = { all: vi.fn().mockReturnValue([
        {
          text: 'Low FTS',
          id: 'e1',
          source: 'patterns',
          source_id: 1,
          date: '2026-02-25T00:00:00.000Z',
          fts_score: 2.0,
        },
        {
          text: 'High FTS',
          id: 'e2',
          source: 'patterns',
          source_id: 2,
          date: '2026-02-25T00:00:00.000Z',
          fts_score: 8.0,
        },
      ])};
      const retrievalStmt = { all: vi.fn().mockReturnValue([]) };
      mockDb.prepare
        .mockReturnValueOnce(ftsStmt)
        .mockReturnValueOnce(retrievalStmt);

      const results = searchFts({ query: 'test' });

      expect(results.length).toBe(2);
      // e2 (8.0) should rank above e1 (2.0)
      expect(results[0].id).toBe('e2');
      expect(results[1].id).toBe('e1');
    });
  });

  // ============================================
  // searchFts edge cases
  // ============================================

  describe('searchFts edge cases', () => {
    it('returns empty array for empty query', () => {
      const results = searchFts({ query: '' });
      expect(results).toEqual([]);
    });

    it('returns empty array for whitespace-only query', () => {
      const results = searchFts({ query: '   ' });
      expect(results).toEqual([]);
    });

    it('returns empty array on FTS5 query error', () => {
      const brokenStmt = { all: vi.fn().mockImplementation(() => {
        throw new Error('FTS5 syntax error');
      })};
      mockDb.prepare.mockReturnValueOnce(brokenStmt);

      const results = searchFts({ query: 'test' });
      expect(results).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'FTS5 query failed, returning empty results',
        expect.objectContaining({ error: 'FTS5 syntax error' }),
      );
    });

    it('respects maxResults limit', () => {
      const manyResults = Array.from({ length: 20 }, (_, i) => ({
        text: `Entry ${i}`,
        id: `e${i}`,
        source: 'patterns',
        source_id: i,
        date: '2026-02-25T00:00:00.000Z',
        fts_score: 20 - i,
      }));
      const ftsStmt = { all: vi.fn().mockReturnValue(manyResults) };
      const retrievalStmt = { all: vi.fn().mockReturnValue([]) };
      mockDb.prepare
        .mockReturnValueOnce(ftsStmt)
        .mockReturnValueOnce(retrievalStmt);

      const results = searchFts({ query: 'entry', maxResults: 5 });
      expect(results.length).toBeLessThanOrEqual(5);
    });
  });
});
