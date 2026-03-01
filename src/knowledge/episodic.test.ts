import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock better-sqlite3 with a proper constructor class
const mockStmt = {
  run: vi.fn().mockReturnValue({ lastInsertRowid: 1, changes: 0 }),
  all: vi.fn().mockReturnValue([]),
};
const mockDb = {
  pragma: vi.fn(),
  exec: vi.fn(),
  prepare: vi.fn().mockReturnValue(mockStmt),
};

function MockDatabase() {
  return mockDb;
}

vi.mock('better-sqlite3', () => ({
  default: MockDatabase,
}));

vi.mock('../config/paths.js', () => ({
  getConfig: vi.fn(() => ({ knowledgeDir: '/tmp/test-episodic' })),
}));

vi.mock('../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
}));

vi.mock('../mcp/with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

// Must import AFTER mocks are declared
let recordEpisode: typeof import('./episodic.js').recordEpisode;
let recallEpisodes: typeof import('./episodic.js').recallEpisodes;
let getRecentEpisodes: typeof import('./episodic.js').getRecentEpisodes;
let registerEpisodicMemoryTools: typeof import('./episodic.js').registerEpisodicMemoryTools;

describe('Episodic Memory', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset default mock returns
    mockStmt.run.mockReturnValue({ lastInsertRowid: 1, changes: 0 });
    mockStmt.all.mockReturnValue([]);

    // Re-import the module fresh to reset the `db` singleton
    vi.resetModules();
    const mod = await import('./episodic.js');
    recordEpisode = mod.recordEpisode;
    recallEpisodes = mod.recallEpisodes;
    getRecentEpisodes = mod.getRecentEpisodes;
    registerEpisodicMemoryTools = mod.registerEpisodicMemoryTools;
  });

  describe('recordEpisode', () => {
    it('inserts into database with correct params', () => {
      recordEpisode('Phase 92', 'Chose SQLite', 'Works great');

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO episodes'),
      );
      expect(mockStmt.run).toHaveBeenCalledWith(
        'Phase 92',
        'Chose SQLite',
        'Works great',
        null,
        '[]',
      );
    });

    it('returns Episode with id from lastInsertRowid', () => {
      mockStmt.run.mockReturnValue({ lastInsertRowid: 42, changes: 1 });

      const episode = recordEpisode('Phase 92', 'Chose SQLite', 'Works great');

      expect(episode.id).toBe(42);
      expect(episode.sprintPhase).toBe('Phase 92');
      expect(episode.action).toBe('Chose SQLite');
      expect(episode.outcome).toBe('Works great');
      expect(episode.timestamp).toBeTruthy();
    });

    it('handles optional lesson and tags', () => {
      mockStmt.run.mockReturnValue({ lastInsertRowid: 5, changes: 1 });

      const episode = recordEpisode(
        'Phase 92',
        'Used FTS5',
        'Fast search',
        'FTS5 is sufficient for local search',
        ['database', 'architecture'],
      );

      expect(episode.lesson).toBe('FTS5 is sufficient for local search');
      expect(episode.tags).toEqual(['database', 'architecture']);
      expect(mockStmt.run).toHaveBeenCalledWith(
        'Phase 92',
        'Used FTS5',
        'Fast search',
        'FTS5 is sufficient for local search',
        '["database","architecture"]',
      );
    });

    it('defaults lesson to null and tags to empty array', () => {
      mockStmt.run.mockReturnValue({ lastInsertRowid: 3, changes: 1 });

      const episode = recordEpisode('Phase 92', 'Action', 'Outcome');

      expect(episode.lesson).toBeNull();
      expect(episode.tags).toEqual([]);
    });
  });

  describe('recallEpisodes', () => {
    it('returns empty array when no valid tokens in query', () => {
      const result = recallEpisodes('! @ # $');

      expect(result).toEqual([]);
    });

    it('builds FTS5 query from tokens joined with OR', () => {
      mockStmt.all.mockReturnValue([]);

      recallEpisodes('database migration');

      // The prepare call should build a MATCH query
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('episodes_fts MATCH ?'),
      );
      // The all() call should use the FTS query with OR-joined tokens
      const allCalls = mockStmt.all.mock.calls;
      const ftsCall = allCalls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes(' OR '),
      );
      expect(ftsCall).toBeTruthy();
      expect(ftsCall![0]).toBe('database OR migration');
    });

    it('filters by sprint phase when provided', () => {
      mockStmt.all.mockReturnValue([]);

      recallEpisodes('database', 10, 'Phase 92');

      // The prepare call should include sprint_phase filter
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('e.sprint_phase = ?'),
      );
      // Should pass sprintPhase as second param and limit as third
      expect(mockStmt.all).toHaveBeenCalledWith('database', 'Phase 92', 10);
    });

    it('limits results to specified count', () => {
      mockStmt.all.mockReturnValue([]);

      recallEpisodes('test', 5);

      expect(mockStmt.all).toHaveBeenCalledWith('test', 5);
    });

    it('maps database rows to Episode objects', () => {
      mockStmt.all.mockReturnValue([
        {
          id: 1,
          sprint_phase: 'Phase 92',
          timestamp: '2026-02-28T10:00:00.000Z',
          action: 'Chose SQLite',
          outcome: 'Works great',
          lesson: 'SQLite is fast',
          tags: '["database"]',
        },
      ]);

      const episodes = recallEpisodes('sqlite');

      expect(episodes).toHaveLength(1);
      expect(episodes[0].id).toBe(1);
      expect(episodes[0].sprintPhase).toBe('Phase 92');
      expect(episodes[0].action).toBe('Chose SQLite');
      expect(episodes[0].tags).toEqual(['database']);
    });

    it('filters tokens shorter than 2 characters', () => {
      mockStmt.all.mockReturnValue([]);

      recallEpisodes('a db x migration');

      // Only "db" and "migration" should remain (both >= 2 chars)
      const allCalls = mockStmt.all.mock.calls;
      const ftsCall = allCalls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('OR'),
      );
      expect(ftsCall).toBeTruthy();
      expect(ftsCall![0]).toBe('db OR migration');
    });
  });

  describe('getRecentEpisodes', () => {
    it('queries by sprint phase with limit', () => {
      mockStmt.all.mockReturnValue([]);

      getRecentEpisodes('Phase 92', 15);

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('WHERE sprint_phase = ?'),
      );
      expect(mockStmt.all).toHaveBeenCalledWith('Phase 92', 15);
    });

    it('maps rows to Episode objects with parsed tags', () => {
      mockStmt.all.mockReturnValue([
        {
          id: 3,
          sprint_phase: 'Phase 92',
          timestamp: '2026-02-28T11:00:00.000Z',
          action: 'Test action',
          outcome: 'Test outcome',
          lesson: null,
          tags: '["tag1","tag2"]',
        },
      ]);

      const episodes = getRecentEpisodes('Phase 92');

      expect(episodes).toHaveLength(1);
      expect(episodes[0].sprintPhase).toBe('Phase 92');
      expect(episodes[0].lesson).toBeNull();
      expect(episodes[0].tags).toEqual(['tag1', 'tag2']);
    });

    it('defaults limit to 20', () => {
      mockStmt.all.mockReturnValue([]);

      getRecentEpisodes('Phase 92');

      expect(mockStmt.all).toHaveBeenCalledWith('Phase 92', 20);
    });
  });

  describe('safeParseTags', () => {
    it('handles valid JSON array tags in episode rows', () => {
      mockStmt.all.mockReturnValue([
        {
          id: 1,
          sprint_phase: 'Phase 92',
          timestamp: '2026-02-28T10:00:00.000Z',
          action: 'Test',
          outcome: 'Test',
          lesson: null,
          tags: '["alpha","beta","gamma"]',
        },
      ]);

      const episodes = getRecentEpisodes('Phase 92');
      expect(episodes[0].tags).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('handles invalid JSON tags gracefully', () => {
      mockStmt.all.mockReturnValue([
        {
          id: 1,
          sprint_phase: 'Phase 92',
          timestamp: '2026-02-28T10:00:00.000Z',
          action: 'Test',
          outcome: 'Test',
          lesson: null,
          tags: 'not valid json',
        },
      ]);

      const episodes = getRecentEpisodes('Phase 92');
      expect(episodes[0].tags).toEqual([]);
    });

    it('handles non-array JSON tags gracefully', () => {
      mockStmt.all.mockReturnValue([
        {
          id: 1,
          sprint_phase: 'Phase 92',
          timestamp: '2026-02-28T10:00:00.000Z',
          action: 'Test',
          outcome: 'Test',
          lesson: null,
          tags: '{"not":"an array"}',
        },
      ]);

      const episodes = getRecentEpisodes('Phase 92');
      expect(episodes[0].tags).toEqual([]);
    });
  });

  describe('registerEpisodicMemoryTools', () => {
    it('registers two tools on the server', () => {
      const mockServer = {
        tool: vi.fn(),
      };

      registerEpisodicMemoryTools(mockServer as never);

      expect(mockServer.tool).toHaveBeenCalledTimes(2);
      expect(mockServer.tool).toHaveBeenCalledWith(
        'record_episode',
        expect.any(String),
        expect.any(Object),
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockServer.tool).toHaveBeenCalledWith(
        'recall_episodes',
        expect.any(String),
        expect.any(Object),
        expect.any(Object),
        expect.any(Function),
      );
    });
  });

  describe('Database initialization', () => {
    it('creates tables and triggers on init', () => {
      mockStmt.run.mockReturnValue({ lastInsertRowid: 1, changes: 0 });

      recordEpisode('Phase 1', 'Init test', 'DB created');

      // db.exec should have been called with table creation SQL
      expect(mockDb.exec).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS episodes'),
      );
      expect(mockDb.exec).toHaveBeenCalledWith(
        expect.stringContaining('CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts'),
      );
      expect(mockDb.exec).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TRIGGER IF NOT EXISTS episodes_ai'),
      );
      expect(mockDb.exec).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TRIGGER IF NOT EXISTS episodes_ad'),
      );
    });

    it('sets WAL journal mode', () => {
      mockStmt.run.mockReturnValue({ lastInsertRowid: 1, changes: 0 });

      recordEpisode('Phase 1', 'Init test', 'DB created');

      expect(mockDb.pragma).toHaveBeenCalledWith('journal_mode = WAL');
    });
  });
});
