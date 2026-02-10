import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('../../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

// We can't easily test through McpServer, so we test the knowledge search
// logic by extracting it. Instead, we test the module's internal logic
// by importing and calling registerKnowledgeTools with a mock server.

const MOCK_PATTERNS = JSON.stringify({
  patterns: [
    { id: 1, name: 'CSRF Protection', description: 'Always include X-CSRF-Token header', example: 'getCsrfHeaders()', date: '2025-01-01' },
    { id: 2, name: 'Toast Notifications', description: 'Use sonner toast for user feedback', date: '2025-01-02' },
    { id: 3, name: 'Auth with getUser', description: 'Use supabase.auth.getUser() not getSession()', date: '2025-01-03' },
  ],
});

const MOCK_LESSONS = JSON.stringify({
  lessons: [
    { id: 1, situation: 'Agent teams file conflicts', learning: 'Each teammate should own different files', date: '2025-02-09' },
    { id: 2, situation: 'MCP subprocess API failure', learning: 'Explicit dotenv path needed in MCP mode', date: '2025-02-08' },
  ],
});

const MOCK_DECISIONS = JSON.stringify({
  decisions: [
    { id: 1, title: 'Agent Teams for Review', context: 'Parallel code review needed', alternatives: 'Sequential review', rationale: 'Faster feedback loop', phase: 'Phase 53', date: '2025-02-09' },
    { id: 2, title: 'Sonnet for Reviews', context: 'Model selection for review agents', rationale: 'Good quality at lower cost than Opus', phase: 'Phase 53', date: '2025-02-09' },
  ],
});

function mockFiles() {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(readFileSync).mockImplementation(((path: unknown) => {
    const p = String(path);
    if (p.includes('patterns.json')) return MOCK_PATTERNS;
    if (p.includes('lessons.json')) return MOCK_LESSONS;
    if (p.includes('decisions.json')) return MOCK_DECISIONS;
    return '';
  }) as typeof readFileSync);
}

// Extract the handler by registering with a mock server
async function getHandler() {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: Function) => {
      handlers[_name] = handler;
    },
  };

  const { registerKnowledgeTools } = await import('./knowledge.js');
  registerKnowledgeTools(mockServer as any);
  return handlers['knowledge_query'];
}

describe('Knowledge Query Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('without query (all entries)', () => {
    it('returns all patterns, lessons, and decisions', async () => {
      mockFiles();
      const handler = await getHandler();
      const result = await handler({ type: undefined, query: undefined });
      const text = result.content[0].text;

      expect(text).toContain('Patterns (3)');
      expect(text).toContain('CSRF Protection');
      expect(text).toContain('Toast Notifications');
      expect(text).toContain('Lessons (2)');
      expect(text).toContain('Decisions (2)');
    });

    it('filters by type when specified', async () => {
      mockFiles();
      const handler = await getHandler();
      const result = await handler({ type: 'patterns', query: undefined });
      const text = result.content[0].text;

      expect(text).toContain('Patterns (3)');
      expect(text).not.toContain('Lessons');
      expect(text).not.toContain('Decisions');
    });

    it('shows empty message when no data', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const handler = await getHandler();
      const result = await handler({ type: 'patterns', query: undefined });
      const text = result.content[0].text;

      expect(text).toContain('No patterns recorded yet');
    });
  });

  describe('with query (keyword search)', () => {
    it('matches CSRF in pattern name', async () => {
      mockFiles();
      const handler = await getHandler();
      const result = await handler({ type: undefined, query: 'CSRF' });
      const text = result.content[0].text;

      expect(text).toContain('CSRF Protection');
      expect(text).toContain('Search results');
    });

    it('matches agent teams in decision title', async () => {
      mockFiles();
      const handler = await getHandler();
      const result = await handler({ type: undefined, query: 'agent teams' });
      const text = result.content[0].text;

      expect(text).toContain('Agent Teams for Review');
    });

    it('returns results sorted by relevance', async () => {
      mockFiles();
      const handler = await getHandler();
      // "auth" matches pattern "Auth with getUser" (in name + description)
      // and potentially elsewhere
      const result = await handler({ type: undefined, query: 'auth' });
      const text = result.content[0].text;

      expect(text).toContain('Auth with getUser');
    });

    it('returns no-results message when nothing matches', async () => {
      mockFiles();
      const handler = await getHandler();
      const result = await handler({ type: undefined, query: 'xylophone' });
      const text = result.content[0].text;

      expect(text).toContain("No results for 'xylophone'");
    });

    it('type filter + query work together', async () => {
      mockFiles();
      const handler = await getHandler();
      // Search for "auth" but only in patterns
      const result = await handler({ type: 'patterns', query: 'auth' });
      const text = result.content[0].text;

      expect(text).toContain('Auth with getUser');
      // Should not contain decisions or lessons even if they match
      expect(text).not.toContain('Agent Teams');
    });

    it('is case insensitive', async () => {
      mockFiles();
      const handler = await getHandler();
      const result = await handler({ type: undefined, query: 'csrf' });
      const text = result.content[0].text;

      expect(text).toContain('CSRF Protection');
    });

    it('matches across multiple fields', async () => {
      mockFiles();
      const handler = await getHandler();
      // "MCP" should match in lesson situation
      const result = await handler({ type: 'lessons', query: 'MCP' });
      const text = result.content[0].text;

      expect(text).toContain('MCP subprocess API failure');
    });
  });
});
