import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, statSync, renameSync } from 'fs';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock('../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    knowledgeDir: '/mock/knowledge',
  })),
}));

vi.mock('../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { getCachedContext, cacheContext, getBankStats, clearBank } from './reasoning-bank.js';

const MOCK_MTIMES: Record<string, number> = {
  'patterns.json': 1000,
  'lessons.json': 2000,
  'decisions.json': 3000,
  'deferred.json': 4000,
};

function mockFileSystem(bankContent: string | null) {
  vi.mocked(existsSync).mockImplementation((path) => {
    const p = String(path);
    if (p.includes('reasoning-bank.json')) return bankContent !== null;
    // Knowledge files
    return Object.keys(MOCK_MTIMES).some(f => p.includes(f));
  });

  if (bankContent !== null) {
    vi.mocked(readFileSync).mockReturnValue(bankContent);
  }

  vi.mocked(statSync).mockImplementation((path) => {
    const p = String(path);
    for (const [file, mtime] of Object.entries(MOCK_MTIMES)) {
      if (p.includes(file)) {
        return { mtimeMs: mtime } as ReturnType<typeof statSync>;
      }
    }
    return { mtimeMs: 0 } as ReturnType<typeof statSync>;
  });
}

describe('ReasoningBank', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getCachedContext', () => {
    it('returns null when bank file does not exist', () => {
      mockFileSystem(null);
      const result = getCachedContext('Add user authentication');
      expect(result).toBeNull();
    });

    it('returns null when no matching entry', () => {
      mockFileSystem(JSON.stringify({
        entries: [{
          key: 'different-hash',
          featureNormalized: 'different feature',
          context: 'cached context',
          sourceHashes: MOCK_MTIMES,
          cachedAt: new Date().toISOString(),
          hits: 0,
        }],
      }));

      const result = getCachedContext('Add user authentication');
      expect(result).toBeNull();
    });

    it('returns null when entry is stale (source files changed)', () => {
      // First cache something
      mockFileSystem(null);
      cacheContext('knowledge graph', 'cached knowledge context');

      // Now read it back but with different mtimes
      const writeCall = vi.mocked(writeFileSync).mock.calls[0];
      const savedContent = writeCall[1] as string;

      // Parse and verify it was saved
      const saved = JSON.parse(savedContent);
      expect(saved.entries).toHaveLength(1);

      // Now simulate stale: change mtime for patterns.json
      const staleMtimes = { ...MOCK_MTIMES, 'patterns.json': 9999 };
      vi.mocked(statSync).mockImplementation((path) => {
        const p = String(path);
        for (const [file, mtime] of Object.entries(staleMtimes)) {
          if (p.includes(file)) {
            return { mtimeMs: mtime } as ReturnType<typeof statSync>;
          }
        }
        return { mtimeMs: 0 } as ReturnType<typeof statSync>;
      });

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(savedContent);

      const result = getCachedContext('knowledge graph');
      expect(result).toBeNull();
    });
  });

  describe('cacheContext', () => {
    it('writes a new entry to the bank', () => {
      mockFileSystem(null);
      cacheContext('Add CSRF protection', 'patterns: CSRF headers required');

      expect(writeFileSync).toHaveBeenCalled();
      const writeCall = vi.mocked(writeFileSync).mock.calls[0];
      const savedContent = JSON.parse(writeCall[1] as string);

      expect(savedContent.entries).toHaveLength(1);
      expect(savedContent.entries[0].context).toBe('patterns: CSRF headers required');
      expect(savedContent.entries[0].hits).toBe(0);
    });

    it('normalizes feature descriptions for deduplication', () => {
      mockFileSystem(null);

      // These should produce the same key
      cacheContext('Add user authentication', 'context A');
      const firstWrite = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);

      vi.mocked(writeFileSync).mockClear();
      vi.mocked(existsSync).mockImplementation((path) => {
        const p = String(path);
        if (p.includes('reasoning-bank.json')) return true;
        return Object.keys(MOCK_MTIMES).some(f => p.includes(f));
      });
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(firstWrite));

      cacheContext('Implement new user authentication', 'context B');
      const secondWrite = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);

      // Should still have 1 entry (upserted)
      expect(secondWrite.entries).toHaveLength(1);
      expect(secondWrite.entries[0].context).toBe('context B');
    });
  });

  describe('getBankStats', () => {
    it('returns zeros for empty bank', () => {
      mockFileSystem(null);
      const stats = getBankStats();
      expect(stats.entries).toBe(0);
      expect(stats.totalHits).toBe(0);
      expect(stats.oldestEntry).toBeNull();
    });

    it('returns correct stats', () => {
      mockFileSystem(JSON.stringify({
        entries: [
          { key: 'a', featureNormalized: 'a', context: '', sourceHashes: {}, cachedAt: '2026-01-01', hits: 3 },
          { key: 'b', featureNormalized: 'b', context: '', sourceHashes: {}, cachedAt: '2026-02-01', hits: 5 },
        ],
      }));

      const stats = getBankStats();
      expect(stats.entries).toBe(2);
      expect(stats.totalHits).toBe(8);
      expect(stats.oldestEntry).toBe('2026-01-01');
    });
  });

  describe('clearBank', () => {
    it('writes empty entries', () => {
      mockFileSystem(null);
      clearBank();

      expect(writeFileSync).toHaveBeenCalled();
      const savedContent = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
      expect(savedContent.entries).toEqual([]);
    });
  });
});
