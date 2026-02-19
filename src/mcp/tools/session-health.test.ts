/**
 * Comprehensive behavioral tests for session-health signal detectors.
 *
 * Tests each of the 7 signal detectors in analyzeSession():
 *   1. no_commits        — >15 tool calls + 0 commits in >20min
 *   2. thrashing         — Same tool called 5+ times in last 30min (benign tools excluded)
 *   3. action_repetition — Same tool called 3+ consecutively (critical if ≥5)
 *   4. high_error_rate   — >40% failure rate on ≥5 recent tool calls
 *   5. stale_progress    — Sprint active but no sprint_progress in >45min
 *   6. no_sprint         — Commits made but no sprint tracking in >10min session
 *   7. long_session      — Session running >120min
 *
 * State manipulation: directly mutate the `session` singleton from session-state.ts.
 * The handler is registered once using a static import so the session object it
 * closes over is the same instance we mutate in tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { session } from './shared/session-state.js';
import { registerSessionHealthTools } from './session-health.js';

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../guardrails/iron-laws.js', () => ({
  recordError: vi.fn(() => 1),
  clearError: vi.fn(),
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

// ─── Register the handler once (static import keeps the same session singleton) ─

let sessionHealthHandler: Function;

{
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
  };
  registerSessionHealthTools(mockServer as any);
  sessionHealthHandler = handlers['session_health'];
}

// ─── Helper: get structured signals ──────────────────────────────────────────

async function getSignals(): Promise<Array<{ id: string; severity: string; message: string; metric: string }>> {
  const result = await sessionHealthHandler({});
  return result.structuredContent.signals;
}

// ─── Helper: build tool-call records ─────────────────────────────────────────

function makeCall(tool: string, success = true, minsAgo = 5): { tool: string; timestamp: number; success: boolean } {
  return { tool, timestamp: Date.now() - minsAgo * 60 * 1000, success };
}

// ─── Reset shared session state before every test ────────────────────────────

beforeEach(() => {
  // Mutate the singleton in-place — same object the handler references
  session.startedAt = Date.now() - 25 * 60 * 1000; // 25 minutes ago (past the 5-min guard)
  session.toolCalls = [];
  session.commitCount = 0;
  session.lastCommitAt = null;
  session.lastProgressAt = null;
  session.sprintActive = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Early-session guard ──────────────────────────────────────────────────────

describe('early session guard', () => {
  it('returns too_early when session is younger than 5 minutes', async () => {
    session.startedAt = Date.now() - 3 * 60 * 1000;

    const signals = await getSignals();

    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe('too_early');
    expect(signals[0].severity).toBe('info');
  });

  it('proceeds past the guard when session is exactly 5 minutes old', async () => {
    // sessionMinutes == 5, which is NOT < 5, so the guard does not fire
    session.startedAt = Date.now() - 5 * 60 * 1000;

    const signals = await getSignals();

    const ids = signals.map(s => s.id);
    expect(ids).not.toContain('too_early');
  });

  it('proceeds past the guard for a mature session', async () => {
    session.startedAt = Date.now() - 30 * 60 * 1000;

    const signals = await getSignals();

    const ids = signals.map(s => s.id);
    expect(ids).not.toContain('too_early');
  });
});

// ─── Signal 1: no_commits ─────────────────────────────────────────────────────

describe('Signal 1: no_commits', () => {
  it('triggers when >15 tool calls, 0 commits, session >20min', async () => {
    session.toolCalls = Array.from({ length: 16 }, (_, i) =>
      makeCall('some_tool', true, i + 1)
    );
    session.commitCount = 0;

    const signals = await getSignals();

    expect(signals.map(s => s.id)).toContain('no_commits');
  });

  it('does NOT trigger when exactly 15 tool calls (threshold is strictly >15)', async () => {
    session.toolCalls = Array.from({ length: 15 }, (_, i) =>
      makeCall('some_tool', true, i + 1)
    );
    session.commitCount = 0;

    const signals = await getSignals();

    expect(signals.map(s => s.id)).not.toContain('no_commits');
  });

  it('does NOT trigger when there is at least 1 commit', async () => {
    session.toolCalls = Array.from({ length: 20 }, (_, i) =>
      makeCall('some_tool', true, i + 1)
    );
    session.commitCount = 1;

    const signals = await getSignals();

    expect(signals.map(s => s.id)).not.toContain('no_commits');
  });

  it('does NOT trigger when session is exactly 20min (threshold is strictly >20)', async () => {
    session.startedAt = Date.now() - 20 * 60 * 1000;
    session.toolCalls = Array.from({ length: 20 }, (_, i) =>
      makeCall('some_tool', true, i + 1)
    );
    session.commitCount = 0;

    const signals = await getSignals();

    expect(signals.map(s => s.id)).not.toContain('no_commits');
  });

  it('signal has warning severity and mentions tool call count', async () => {
    session.toolCalls = Array.from({ length: 18 }, (_, i) =>
      makeCall('some_tool', true, i + 1)
    );
    session.commitCount = 0;

    const signals = await getSignals();
    const signal = signals.find(s => s.id === 'no_commits');

    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('warning');
    expect(signal!.message).toContain('18 tool calls');
  });
});

// ─── Signal 2: thrashing ──────────────────────────────────────────────────────

describe('Signal 2: thrashing', () => {
  it('triggers when same tool is called 5 times in the last 30min', async () => {
    session.toolCalls = Array.from({ length: 5 }, (_, i) =>
      makeCall('bash_execute', true, i + 1)
    );

    const signals = await getSignals();
    const signal = signals.find(s => s.id === 'thrashing');

    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('warning');
    expect(signal!.message).toContain('"bash_execute"');
  });

  it('triggers when same tool is called more than 5 times', async () => {
    session.toolCalls = Array.from({ length: 8 }, (_, i) =>
      makeCall('grep_search', true, i + 1)
    );

    const signals = await getSignals();

    expect(signals.map(s => s.id)).toContain('thrashing');
  });

  it('does NOT trigger when a tool is called only 4 times', async () => {
    session.toolCalls = Array.from({ length: 4 }, (_, i) =>
      makeCall('bash_execute', true, i + 1)
    );

    const signals = await getSignals();

    expect(signals.map(s => s.id)).not.toContain('thrashing');
  });

  it('does NOT trigger for benign tool: sprint_progress', async () => {
    session.toolCalls = Array.from({ length: 10 }, (_, i) =>
      makeCall('sprint_progress', true, i + 1)
    );

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('thrashing');
  });

  it('does NOT trigger for benign tool: health_check', async () => {
    session.toolCalls = Array.from({ length: 10 }, (_, i) =>
      makeCall('health_check', true, i + 1)
    );

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('thrashing');
  });

  it('does NOT trigger for benign tool: session_health', async () => {
    session.toolCalls = Array.from({ length: 10 }, (_, i) =>
      makeCall('session_health', true, i + 1)
    );

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('thrashing');
  });

  it('does NOT trigger for benign tool: production_status', async () => {
    session.toolCalls = Array.from({ length: 8 }, (_, i) =>
      makeCall('production_status', true, i + 1)
    );

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('thrashing');
  });

  it('does NOT trigger for benign tool: cognitive_load', async () => {
    session.toolCalls = Array.from({ length: 7 }, (_, i) =>
      makeCall('cognitive_load', true, i + 1)
    );

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('thrashing');
  });

  it('does NOT trigger when all 5 calls are older than 30min (outside window)', async () => {
    session.toolCalls = Array.from({ length: 5 }, (_, i) =>
      makeCall('bash_execute', true, 35 + i)
    );

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('thrashing');
  });

  it('only counts calls inside the 30min window (3 old + 4 recent = 4 recent, below threshold)', async () => {
    const oldCalls = Array.from({ length: 3 }, () => makeCall('bash_execute', true, 40));
    const recentCalls = Array.from({ length: 4 }, (_, i) => makeCall('bash_execute', true, i + 1));
    session.toolCalls = [...oldCalls, ...recentCalls];

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('thrashing');
  });

  it('metric string includes the count', async () => {
    session.toolCalls = Array.from({ length: 7 }, (_, i) =>
      makeCall('read_file', true, i + 1)
    );

    const signals = await getSignals();
    const signal = signals.find(s => s.id === 'thrashing');

    expect(signal).toBeDefined();
    expect(signal!.metric).toContain('7x in 30m');
  });
});

// ─── Signal 3: action_repetition ──────────────────────────────────────────────

describe('Signal 3: action_repetition', () => {
  it('triggers at warning severity when same tool called 3 times consecutively', async () => {
    session.toolCalls = [
      makeCall('tool_a', true, 10),
      makeCall('bash_execute', true, 5),
      makeCall('bash_execute', true, 4),
      makeCall('bash_execute', true, 3),
    ];

    const signals = await getSignals();
    const signal = signals.find(s => s.id === 'action_repetition');

    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('warning');
    expect(signal!.message).toContain('"bash_execute"');
    expect(signal!.message).toContain('3 times consecutively');
  });

  it('triggers at warning severity for exactly 4 consecutive calls', async () => {
    session.toolCalls = [
      makeCall('tool_a', true, 15),
      makeCall('read_file', true, 10),
      makeCall('read_file', true, 8),
      makeCall('read_file', true, 6),
      makeCall('read_file', true, 4),
    ];

    const signals = await getSignals();
    const signal = signals.find(s => s.id === 'action_repetition');

    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('warning');
  });

  it('triggers at critical severity when same tool called 5 times consecutively', async () => {
    session.toolCalls = [
      makeCall('tool_a', true, 20),
      makeCall('bash_execute', true, 10),
      makeCall('bash_execute', true, 8),
      makeCall('bash_execute', true, 6),
      makeCall('bash_execute', true, 4),
      makeCall('bash_execute', true, 2),
    ];

    const signals = await getSignals();
    const signal = signals.find(s => s.id === 'action_repetition');

    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('critical');
    expect(signal!.message).toContain('5 times consecutively');
  });

  it('triggers at critical severity for 6 consecutive calls', async () => {
    session.toolCalls = [
      makeCall('tool_x', true, 20),
      ...Array.from({ length: 6 }, (_, i) => makeCall('read_file', true, 12 - i * 2)),
    ];

    const signals = await getSignals();
    const signal = signals.find(s => s.id === 'action_repetition');

    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('critical');
  });

  it('does NOT trigger when only 2 consecutive calls', async () => {
    session.toolCalls = [
      makeCall('tool_a', true, 10),
      makeCall('bash_execute', true, 5),
      makeCall('bash_execute', true, 3),
    ];

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('action_repetition');
  });

  it('does NOT trigger when consecutive streak is broken before reaching 3', async () => {
    // Pattern: A, B, B, A — trailing streak is just A (1 call)
    session.toolCalls = [
      makeCall('bash_execute', true, 15),
      makeCall('read_file', true, 10),
      makeCall('read_file', true, 8),
      makeCall('bash_execute', true, 3),
    ];

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('action_repetition');
  });

  it('does NOT trigger for benign tool: sprint_progress consecutive calls', async () => {
    session.toolCalls = Array.from({ length: 5 }, (_, i) =>
      makeCall('sprint_progress', true, 10 - i * 2)
    );

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('action_repetition');
  });

  it('does NOT trigger for benign tool: health_check consecutive calls', async () => {
    session.toolCalls = Array.from({ length: 5 }, (_, i) =>
      makeCall('health_check', true, 10 - i * 2)
    );

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('action_repetition');
  });

  it('does NOT trigger for benign tool: session_health consecutive calls', async () => {
    session.toolCalls = Array.from({ length: 5 }, (_, i) =>
      makeCall('session_health', true, 10 - i * 2)
    );

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('action_repetition');
  });

  it('does NOT trigger for benign tool: production_status consecutive calls', async () => {
    session.toolCalls = Array.from({ length: 5 }, (_, i) =>
      makeCall('production_status', true, 10 - i * 2)
    );

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('action_repetition');
  });

  it('does NOT trigger for benign tool: cognitive_load consecutive calls', async () => {
    session.toolCalls = Array.from({ length: 5 }, (_, i) =>
      makeCall('cognitive_load', true, 10 - i * 2)
    );

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('action_repetition');
  });

  it('does NOT trigger when fewer than 3 calls are in the 30min window', async () => {
    session.toolCalls = [
      makeCall('bash_execute', true, 10),
      makeCall('bash_execute', true, 5),
    ];

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('action_repetition');
  });

  it('only looks at the trailing consecutive run, not earlier identical streaks', async () => {
    // 4x bash_execute long ago, then read_file, then 2x bash_execute — trailing streak is 2
    session.toolCalls = [
      makeCall('bash_execute', true, 20),
      makeCall('bash_execute', true, 18),
      makeCall('bash_execute', true, 16),
      makeCall('bash_execute', true, 14),
      makeCall('read_file', true, 8),
      makeCall('bash_execute', true, 5),
      makeCall('bash_execute', true, 3),
    ];

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('action_repetition');
  });

  it('metric string reports the consecutive count', async () => {
    session.toolCalls = [
      makeCall('tool_x', true, 20),
      makeCall('bash_execute', true, 10),
      makeCall('bash_execute', true, 8),
      makeCall('bash_execute', true, 6),
      makeCall('bash_execute', true, 4),
    ];

    const signals = await getSignals();
    const signal = signals.find(s => s.id === 'action_repetition');

    expect(signal).toBeDefined();
    expect(signal!.metric).toContain('4x consecutive');
  });
});

// ─── Signal 4: high_error_rate ────────────────────────────────────────────────

describe('Signal 4: high_error_rate', () => {
  it('triggers when >40% of ≥5 recent calls failed (3/5 = 60%)', async () => {
    session.toolCalls = [
      makeCall('tool_a', false, 5),
      makeCall('tool_b', false, 4),
      makeCall('tool_c', false, 3),
      makeCall('tool_d', true, 2),
      makeCall('tool_e', true, 1),
    ];

    const signals = await getSignals();
    const signal = signals.find(s => s.id === 'high_error_rate');

    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('critical');
  });

  it('does NOT trigger when error rate is exactly 40% (2/5 — threshold is strictly >40%)', async () => {
    session.toolCalls = [
      makeCall('a', false, 5),
      makeCall('b', false, 4),
      makeCall('c', true, 3),
      makeCall('d', true, 2),
      makeCall('e', true, 1),
    ];

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('high_error_rate');
  });

  it('does NOT trigger when fewer than 5 recent calls (even if 100% failure)', async () => {
    session.toolCalls = [
      makeCall('a', false, 4),
      makeCall('b', false, 3),
      makeCall('c', false, 2),
      makeCall('d', false, 1),
    ];

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('high_error_rate');
  });

  it('does NOT trigger when all recent calls succeed', async () => {
    session.toolCalls = Array.from({ length: 10 }, (_, i) =>
      makeCall('tool_a', true, i + 1)
    );

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('high_error_rate');
  });

  it('only counts calls inside the 30min window for the rate calculation', async () => {
    // 5 old failures (outside window) + 5 recent successes = 0% in-window error rate
    const oldFails = Array.from({ length: 5 }, () => makeCall('tool_a', false, 40));
    const recentOk = Array.from({ length: 5 }, (_, i) => makeCall('tool_b', true, i + 1));
    session.toolCalls = [...oldFails, ...recentOk];

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('high_error_rate');
  });

  it('signal message includes failure count, total, and percentage', async () => {
    session.toolCalls = [
      makeCall('a', false, 5),
      makeCall('b', false, 4),
      makeCall('c', false, 3),
      makeCall('d', true, 2),
      makeCall('e', true, 1),
    ];

    const signals = await getSignals();
    const signal = signals.find(s => s.id === 'high_error_rate');

    expect(signal).toBeDefined();
    expect(signal!.message).toContain('3/5');
    expect(signal!.message).toContain('60% error rate');
  });

  it('triggers with 10 calls and 5 failures (50% rate)', async () => {
    session.toolCalls = [
      ...Array.from({ length: 5 }, (_, i) => makeCall('failing_tool', false, 10 - i)),
      ...Array.from({ length: 5 }, (_, i) => makeCall('ok_tool', true, i + 1)),
    ];

    const signals = await getSignals();
    expect(signals.map(s => s.id)).toContain('high_error_rate');
  });
});

// ─── Signal 5: stale_progress ─────────────────────────────────────────────────

describe('Signal 5: stale_progress', () => {
  describe('when sprint_progress was previously called', () => {
    it('triggers when last progress was >45min ago', async () => {
      session.sprintActive = true;
      session.lastProgressAt = Date.now() - 50 * 60 * 1000;

      const signals = await getSignals();
      const signal = signals.find(s => s.id === 'stale_progress');

      expect(signal).toBeDefined();
      expect(signal!.severity).toBe('warning');
    });

    it('does NOT trigger when last progress was exactly 45min ago (threshold is strictly >45)', async () => {
      session.sprintActive = true;
      session.lastProgressAt = Date.now() - 45 * 60 * 1000;

      const signals = await getSignals();
      expect(signals.map(s => s.id)).not.toContain('stale_progress');
    });

    it('does NOT trigger when last progress was 30min ago', async () => {
      session.sprintActive = true;
      session.lastProgressAt = Date.now() - 30 * 60 * 1000;

      const signals = await getSignals();
      expect(signals.map(s => s.id)).not.toContain('stale_progress');
    });

    it('does NOT trigger when last progress was 1min ago', async () => {
      session.sprintActive = true;
      session.lastProgressAt = Date.now() - 1 * 60 * 1000;

      const signals = await getSignals();
      expect(signals.map(s => s.id)).not.toContain('stale_progress');
    });

    it('message includes approximate minutes since last progress', async () => {
      session.sprintActive = true;
      session.lastProgressAt = Date.now() - 60 * 60 * 1000;

      const signals = await getSignals();
      const signal = signals.find(s => s.id === 'stale_progress');

      expect(signal).toBeDefined();
      expect(signal!.message).toContain('60m');
    });
  });

  describe('when sprint_progress was never called (lastProgressAt is null)', () => {
    it('triggers when sprint is active and session has run >45min with no progress logged', async () => {
      session.sprintActive = true;
      session.lastProgressAt = null;
      session.startedAt = Date.now() - 50 * 60 * 1000; // 50-min session

      const signals = await getSignals();
      const signal = signals.find(s => s.id === 'stale_progress');

      expect(signal).toBeDefined();
      expect(signal!.severity).toBe('warning');
      expect(signal!.message).toContain('sprint_progress never called');
    });

    it('does NOT trigger when sprint is active but session is only 40min old', async () => {
      session.sprintActive = true;
      session.lastProgressAt = null;
      session.startedAt = Date.now() - 40 * 60 * 1000;

      const signals = await getSignals();
      expect(signals.map(s => s.id)).not.toContain('stale_progress');
    });

    it('does NOT trigger when session is exactly 45min old (threshold is strictly >45)', async () => {
      session.sprintActive = true;
      session.lastProgressAt = null;
      session.startedAt = Date.now() - 45 * 60 * 1000;

      const signals = await getSignals();
      expect(signals.map(s => s.id)).not.toContain('stale_progress');
    });
  });

  it('does NOT trigger when sprint is not active (even with stale lastProgressAt)', async () => {
    session.sprintActive = false;
    session.lastProgressAt = Date.now() - 90 * 60 * 1000;

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('stale_progress');
  });

  it('does NOT trigger when sprint is not active and progress was never logged', async () => {
    session.sprintActive = false;
    session.lastProgressAt = null;
    session.startedAt = Date.now() - 60 * 60 * 1000;

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('stale_progress');
  });
});

// ─── Signal 6: no_sprint ──────────────────────────────────────────────────────

describe('Signal 6: no_sprint', () => {
  it('triggers when commits made but no sprint active and session >10min', async () => {
    // beforeEach sets startedAt to 25min ago — already past the 10-min gate
    session.sprintActive = false;
    session.commitCount = 1;

    const signals = await getSignals();
    const signal = signals.find(s => s.id === 'no_sprint');

    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('info');
  });

  it('signal metric includes the commit count', async () => {
    session.sprintActive = false;
    session.commitCount = 5;

    const signals = await getSignals();
    const signal = signals.find(s => s.id === 'no_sprint');

    expect(signal).toBeDefined();
    // message is static; commit count appears in the metric field
    expect(signal!.metric).toContain('5 commits, no sprint');
  });

  it('does NOT trigger when sprint is active', async () => {
    session.sprintActive = true;
    session.commitCount = 3;

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('no_sprint');
  });

  it('does NOT trigger when there are 0 commits', async () => {
    session.sprintActive = false;
    session.commitCount = 0;

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('no_sprint');
  });

  it('does NOT trigger when session is exactly 10min old (threshold is strictly >10)', async () => {
    session.startedAt = Date.now() - 10 * 60 * 1000;
    session.sprintActive = false;
    session.commitCount = 2;

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('no_sprint');
  });

  it('triggers when session is 11min old with commits and no sprint', async () => {
    session.startedAt = Date.now() - 11 * 60 * 1000;
    session.sprintActive = false;
    session.commitCount = 1;

    const signals = await getSignals();
    expect(signals.map(s => s.id)).toContain('no_sprint');
  });
});

// ─── Signal 7: long_session ───────────────────────────────────────────────────

describe('Signal 7: long_session', () => {
  it('triggers when session has been running >120min', async () => {
    session.startedAt = Date.now() - 125 * 60 * 1000;

    const signals = await getSignals();
    const signal = signals.find(s => s.id === 'long_session');

    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('info');
    expect(signal!.message).toContain('/strategic-compact');
  });

  it('does NOT trigger when session is exactly 120min (threshold is strictly >120)', async () => {
    session.startedAt = Date.now() - 120 * 60 * 1000;

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('long_session');
  });

  it('does NOT trigger when session is only 90min old', async () => {
    session.startedAt = Date.now() - 90 * 60 * 1000;

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('long_session');
  });

  it('triggers for a very long 4-hour session', async () => {
    session.startedAt = Date.now() - 240 * 60 * 1000;

    const signals = await getSignals();
    expect(signals.map(s => s.id)).toContain('long_session');
  });

  it('metric string includes the session duration in minutes', async () => {
    session.startedAt = Date.now() - 150 * 60 * 1000;

    const signals = await getSignals();
    const signal = signals.find(s => s.id === 'long_session');

    expect(signal).toBeDefined();
    expect(signal!.metric).toContain('150m');
  });
});

// ─── Healthy state (no signals) ───────────────────────────────────────────────

describe('healthy session (no signals triggered)', () => {
  it('returns the healthy signal when no concerning patterns are detected', async () => {
    session.sprintActive = true;
    session.commitCount = 2;
    session.lastProgressAt = Date.now() - 10 * 60 * 1000;
    session.toolCalls = [
      makeCall('bash_execute', true, 5),
      makeCall('read_file', true, 3),
      makeCall('sprint_progress', true, 2),
    ];

    const signals = await getSignals();

    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe('healthy');
    expect(signals[0].severity).toBe('info');
  });

  it('healthy signal is absent when any other signal fires', async () => {
    // Trigger no_commits
    session.toolCalls = Array.from({ length: 20 }, (_, i) =>
      makeCall('tool_a', true, i + 1)
    );
    session.commitCount = 0;

    const signals = await getSignals();
    expect(signals.map(s => s.id)).not.toContain('healthy');
  });
});

// ─── Multiple simultaneous signals ────────────────────────────────────────────

describe('multiple concurrent signals', () => {
  it('can return no_commits and long_session together', async () => {
    session.startedAt = Date.now() - 130 * 60 * 1000; // 130-min session
    session.commitCount = 0;
    session.toolCalls = Array.from({ length: 20 }, (_, i) =>
      makeCall('bash_execute', true, i + 1)
    );

    const signals = await getSignals();
    const ids = signals.map(s => s.id);

    expect(ids).toContain('no_commits');
    expect(ids).toContain('long_session');
    expect(ids).not.toContain('healthy');
  });

  it('can return thrashing and high_error_rate together', async () => {
    // 7 calls to same tool (thrashing) with 3 failures (>40% error rate)
    session.toolCalls = [
      makeCall('bash_execute', false, 10),
      makeCall('bash_execute', false, 9),
      makeCall('bash_execute', false, 8),
      makeCall('bash_execute', true, 7),
      makeCall('bash_execute', true, 6),
      makeCall('bash_execute', true, 5),
      makeCall('bash_execute', true, 4),
    ];

    const signals = await getSignals();
    const ids = signals.map(s => s.id);

    expect(ids).toContain('thrashing');
    expect(ids).toContain('high_error_rate');
  });
});

// ─── event recording via handler params ──────────────────────────────────────

describe('event recording via handler params', () => {
  it('increments commitCount when record_commit=true', async () => {
    const before = session.commitCount;

    await sessionHealthHandler({ record_commit: true });

    expect(session.commitCount).toBe(before + 1);
  });

  it('response text for record_commit includes the updated total', async () => {
    session.commitCount = 3;

    const result = await sessionHealthHandler({ record_commit: true });
    const text = result.content[0].text;

    expect(text).toContain('4');
  });

  it('appends a tool call record when record_tool is provided', async () => {
    const before = session.toolCalls.length;

    await sessionHealthHandler({ record_tool: 'bash_execute', record_success: true });

    expect(session.toolCalls.length).toBe(before + 1);
    expect(session.toolCalls[session.toolCalls.length - 1].tool).toBe('bash_execute');
    expect(session.toolCalls[session.toolCalls.length - 1].success).toBe(true);
  });

  it('defaults record_success to true when omitted', async () => {
    await sessionHealthHandler({ record_tool: 'some_tool' });

    const lastCall = session.toolCalls[session.toolCalls.length - 1];
    expect(lastCall.success).toBe(true);
  });

  it('records a failed tool call when record_success=false', async () => {
    await sessionHealthHandler({ record_tool: 'failing_tool', record_success: false });

    const lastCall = session.toolCalls[session.toolCalls.length - 1];
    expect(lastCall.tool).toBe('failing_tool');
    expect(lastCall.success).toBe(false);
  });
});

// ─── formatHealthReport overall status label ──────────────────────────────────

describe('formatHealthReport overall status label', () => {
  it('reports "healthy" when there are no warnings or criticals', async () => {
    session.sprintActive = true;
    session.commitCount = 1;
    session.lastProgressAt = Date.now() - 5 * 60 * 1000;

    const result = await sessionHealthHandler({});
    expect(result.content[0].text).toContain('**healthy**');
  });

  it('reports "unhealthy" when at least 1 critical signal exists', async () => {
    // high_error_rate (critical): 3 failures out of 5
    session.toolCalls = [
      makeCall('a', false, 5),
      makeCall('b', false, 4),
      makeCall('c', false, 3),
      makeCall('d', true, 2),
      makeCall('e', true, 1),
    ];

    const result = await sessionHealthHandler({});
    expect(result.content[0].text).toContain('**unhealthy**');
  });

  it('reports "concerning" when 2+ warnings and no criticals', async () => {
    // Trigger no_commits (warning): >15 calls, 0 commits, >20min session
    // Trigger stale_progress (warning): sprint active, lastProgressAt null, >45min session
    // Avoid thrashing + action_repetition by spreading calls across many distinct tool names
    session.startedAt = Date.now() - 55 * 60 * 1000;
    session.commitCount = 0;
    session.sprintActive = true;
    session.lastProgressAt = null;
    // 16 calls to 16 different tools — no single tool reaches 5 calls (no thrashing)
    // and no consecutive runs of 3 (no action_repetition)
    session.toolCalls = Array.from({ length: 16 }, (_, i) =>
      makeCall(`unique_tool_${i}`, true, i + 1)
    );

    const result = await sessionHealthHandler({});
    expect(result.content[0].text).toContain('**concerning**');
  });

  it('reports "minor_issues" when exactly 1 warning and no criticals', async () => {
    // Only no_commits fires (warning): >15 calls, 0 commits, >20min session
    // Use unique tool names to prevent thrashing or action_repetition from also firing
    session.commitCount = 0;
    session.sprintActive = false;
    session.toolCalls = Array.from({ length: 16 }, (_, i) =>
      makeCall(`unique_tool_${i}`, true, i + 1)
    );

    const result = await sessionHealthHandler({});
    expect(result.content[0].text).toContain('**minor_issues**');
  });
});
