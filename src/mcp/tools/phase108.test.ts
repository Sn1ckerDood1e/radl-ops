/**
 * Phase 108 Tests — Cost & Core Hooks
 *
 * Tests for T1-T8 features:
 * - Session state initialization + recording (T3)
 * - Knowledge query depth/brief mode (T7)
 * - Effort scaling type export (T2)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';

// ─── Mocks (minimal — only what these tests need) ───────

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
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

vi.mock('../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    radlDir: '/tmp/test-radl',
    radlOpsDir: '/tmp/test-ops',
    knowledgeDir: '/tmp/test-knowledge',
    usageLogsDir: '/tmp/test-logs',
    sprintScript: '/tmp/test.sh',
    compoundScript: '/tmp/test-compound.sh',
  })),
}));

// ─── T3: Session State ──────────────────────────────────

describe('Session State (T3)', () => {
  it('initializes with preFlightPassed=false and preFlightAt=null', async () => {
    const { session } = await import('./shared/session-state.js');

    expect(session.preFlightPassed).toBe(false);
    expect(session.preFlightAt).toBeNull();
  });

  it('has all expected fields in SessionMetrics', async () => {
    const { session } = await import('./shared/session-state.js');

    expect(session).toHaveProperty('startedAt');
    expect(typeof session.startedAt).toBe('number');
    expect(session).toHaveProperty('toolCalls');
    expect(Array.isArray(session.toolCalls)).toBe(true);
    expect(session).toHaveProperty('commitCount');
    expect(session).toHaveProperty('lastCommitAt');
    expect(session).toHaveProperty('lastProgressAt');
    expect(session).toHaveProperty('sprintActive');
    expect(session).toHaveProperty('preFlightPassed');
    expect(session).toHaveProperty('preFlightAt');
  });

  it('recordToolCall tracks sprint lifecycle', async () => {
    const { session, recordToolCall } = await import('./shared/session-state.js');

    session.sprintActive = false;
    session.lastProgressAt = null;

    recordToolCall('sprint_start', true);
    expect(session.sprintActive).toBe(true);

    recordToolCall('sprint_progress', true);
    expect(session.lastProgressAt).not.toBeNull();

    recordToolCall('sprint_complete', true);
    expect(session.sprintActive).toBe(false);
  });

  it('recordToolCall ignores failed calls for state updates', async () => {
    const { session, recordToolCall } = await import('./shared/session-state.js');

    session.sprintActive = false;
    recordToolCall('sprint_start', false);
    expect(session.sprintActive).toBe(false);
  });

  it('recordToolCall caps tool call records at 500', async () => {
    const { session, recordToolCall } = await import('./shared/session-state.js');

    // Fill beyond 500
    session.toolCalls = [];
    for (let i = 0; i < 510; i++) {
      recordToolCall('test_tool', true);
    }

    expect(session.toolCalls.length).toBeLessThanOrEqual(500);
  });

  it('recordCommit increments count and sets timestamp', async () => {
    const { session, recordCommit } = await import('./shared/session-state.js');

    const initialCount = session.commitCount;
    recordCommit();
    expect(session.commitCount).toBe(initialCount + 1);
    expect(session.lastCommitAt).not.toBeNull();
    expect(typeof session.lastCommitAt).toBe('number');
  });
});

// ─── T7: Knowledge Query Depth ──────────────────────────

describe('Knowledge Query Depth (T7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
  });

  async function getKnowledgeHandler() {
    const handlers: Record<string, Function> = {};
    const mockServer = {
      tool: (...args: unknown[]) => {
        const name = args[0] as string;
        handlers[name] = args[args.length - 1] as Function;
      },
    };

    const { registerKnowledgeTools } = await import('./knowledge.js');
    registerKnowledgeTools(mockServer as any);
    return handlers['knowledge_query'];
  }

  function mockKnowledgeFiles() {
    vi.mocked(readFileSync).mockImplementation((path: any) => {
      const p = String(path);
      if (p.includes('patterns.json')) return JSON.stringify({ patterns: [{ id: 1, name: 'TestP', description: 'desc', date: '2026-01-01' }] });
      if (p.includes('lessons.json')) return JSON.stringify({ lessons: [{ id: 1, situation: 'a', learning: 'b', date: '2026-01-01' }, { id: 2, situation: 'c', learning: 'd', date: '2026-01-01' }] });
      if (p.includes('decisions.json')) return JSON.stringify({ decisions: [] });
      if (p.includes('deferred.json')) return JSON.stringify({ items: [] });
      if (p.includes('team-runs.json')) return JSON.stringify({ runs: [] });
      return '{}';
    });
  }

  it('brief mode returns counts only', async () => {
    mockKnowledgeFiles();
    const handler = await getKnowledgeHandler();
    const result = await handler({ depth: 'brief' });

    expect(result.content[0].text).toContain('Knowledge counts');
    expect(result.content[0].text).toContain('patterns: 1');
    expect(result.content[0].text).toContain('lessons: 2');
    // Should NOT contain full formatted output
    expect(result.content[0].text).not.toContain('## Patterns');
  });

  it('standard mode returns formatted entries (default)', async () => {
    mockKnowledgeFiles();
    const handler = await getKnowledgeHandler();
    const result = await handler({});

    expect(result.content[0].text).toContain('TestP');
    expect(result.content[0].text).toContain('## Patterns');
  });

  it('brief mode with query falls through to search', async () => {
    mockKnowledgeFiles();
    const handler = await getKnowledgeHandler();
    const result = await handler({ depth: 'brief', query: 'TestP' });

    // Query search should still work even with brief depth
    expect(result.content[0].text).toContain('TestP');
  });
});

// ─── T2: Effort Scaling ─────────────────────────────────

describe('Effort Scaling (T2)', () => {
  it('sprint conductor module exports EffortLevel type', async () => {
    // EffortLevel is a type-only export, but the module itself should be loadable
    const module = await import('./sprint-conductor.js');
    expect(module).toBeDefined();
    expect(module.registerSprintConductorTools).toBeDefined();
  });
});
