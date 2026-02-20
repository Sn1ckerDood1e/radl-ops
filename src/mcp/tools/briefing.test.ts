/**
 * Behavioral tests for MCP Briefing tools (daily_briefing, weekly_briefing, roadmap_ideas).
 *
 * Tests:
 * 1. Daily briefing — prompt construction, eval-opt invocation, Gmail delivery
 * 2. Weekly briefing — date range, prompt structure, Gmail delivery
 * 3. Roadmap ideas — Opus routing, error handling
 * 4. Deferred items — auto-population, "none" skip, store loading
 * 5. Markdown to HTML conversion
 * 6. Quality metadata in output
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

const mockRunEvalOptLoop = vi.fn();
vi.mock('../../patterns/evaluator-optimizer.js', () => ({
  runEvalOptLoop: (...args: unknown[]) => mockRunEvalOptLoop(...args),
}));

const mockMessagesCreate = vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: '## Feature Ideas\n\n1. Attendance tracking' }],
});

vi.mock('../../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(() => ({
    messages: {
      create: (...args: unknown[]) => mockMessagesCreate(...args),
    },
  })),
}));

vi.mock('../../models/router.js', () => ({
  getRoute: vi.fn(() => ({ model: 'claude-3-haiku-20240307', maxTokens: 4096 })),
}));

vi.mock('../../models/token-tracker.js', () => ({
  getCostSummaryForBriefing: vi.fn(() => '$0.12 today (1,234 input / 567 output tokens)'),
}));

vi.mock('../../utils/retry.js', () => ({
  withRetry: vi.fn((fn: Function) => fn()),
}));

const mockSendGmail = vi.fn();
const mockIsGoogleConfigured = vi.fn();

vi.mock('../../integrations/google.js', () => ({
  sendGmail: (...args: unknown[]) => mockSendGmail(...args),
  isGoogleConfigured: () => mockIsGoogleConfigured(),
}));

const mockConfig = {
  google: { briefingRecipient: 'founder@radl.solutions' },
};

vi.mock('../../config/index.js', () => ({
  config: mockConfig,
}));

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

vi.mock('../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    knowledgeDir: '/tmp/test-knowledge',
  })),
}));

// ─── Extract handlers ───────────────────────────────────────────────────────

const handlers: Record<string, Function> = {};

{
  const mockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
  };

  const { registerBriefingTools } = await import('./briefing.js');
  registerBriefingTools(mockServer as any);
}

// ─── Default eval-opt result ────────────────────────────────────────────────

function makeEvalOptResult(overrides: Partial<{
  finalOutput: string;
  finalScore: number;
  iterations: number;
  converged: boolean;
  totalCostUsd: number;
  errors: string[];
}> = {}) {
  return {
    finalOutput: '# Daily Briefing\n\n## Summary\nAll systems healthy.\n\n## Key Metrics\n- 0 errors\n\n## Priorities\n- Ship feature X',
    finalScore: 8,
    iterations: 1,
    converged: true,
    totalCostUsd: 0.003,
    errors: [],
    ...overrides,
  };
}

// ─── Reset ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockRunEvalOptLoop.mockResolvedValue(makeEvalOptResult());
  mockIsGoogleConfigured.mockReturnValue(true);
  mockSendGmail.mockResolvedValue({ messageId: 'briefing-msg-1' });
  mockExistsSync.mockReturnValue(false); // No deferred.json by default
});

// ─── Daily Briefing ─────────────────────────────────────────────────────────

describe('daily_briefing', () => {
  it('calls runEvalOptLoop with briefing prompt and returns output', async () => {
    const result = await handlers['daily_briefing']({});
    const text = result.content[0].text;

    expect(mockRunEvalOptLoop).toHaveBeenCalledTimes(1);
    expect(text).toContain('Daily Briefing');
    expect(text).toContain('All systems healthy');
  });

  it('includes quality metadata in output', async () => {
    const result = await handlers['daily_briefing']({});
    const text = result.content[0].text;

    expect(text).toContain('Quality: 8/10');
    expect(text).toContain('Iterations: 1');
    expect(text).toContain('Converged: true');
  });

  it('uses eval-opt with quality threshold 7 and max 2 iterations', async () => {
    await handlers['daily_briefing']({});

    const evalOptArgs = mockRunEvalOptLoop.mock.calls[0][1];
    expect(evalOptArgs.qualityThreshold).toBe(7);
    expect(evalOptArgs.maxIterations).toBe(2);
    expect(evalOptArgs.generatorTaskType).toBe('briefing');
    expect(evalOptArgs.evaluatorTaskType).toBe('review');
  });

  it('includes github_context in prompt when provided', async () => {
    await handlers['daily_briefing']({ github_context: '5 open PRs, 2 failing checks' });

    const prompt = mockRunEvalOptLoop.mock.calls[0][0];
    expect(prompt).toContain('5 open PRs, 2 failing checks');
    expect(prompt).toContain('GitHub Activity');
  });

  it('includes monitoring_context in prompt when provided', async () => {
    await handlers['daily_briefing']({ monitoring_context: 'Vercel: OK, Supabase: OK' });

    const prompt = mockRunEvalOptLoop.mock.calls[0][0];
    expect(prompt).toContain('Vercel: OK, Supabase: OK');
    expect(prompt).toContain('Production Status');
  });

  it('includes calendar_context in prompt when provided', async () => {
    await handlers['daily_briefing']({ calendar_context: '10am standup, 2pm sprint review' });

    const prompt = mockRunEvalOptLoop.mock.calls[0][0];
    expect(prompt).toContain('10am standup, 2pm sprint review');
    expect(prompt).toContain("Today's Calendar");
  });

  it('includes custom_focus in prompt when provided', async () => {
    await handlers['daily_briefing']({ custom_focus: 'onboarding flow' });

    const prompt = mockRunEvalOptLoop.mock.calls[0][0];
    expect(prompt).toContain('onboarding flow');
  });

  it('includes API cost summary in prompt', async () => {
    await handlers['daily_briefing']({});

    const prompt = mockRunEvalOptLoop.mock.calls[0][0];
    expect(prompt).toContain('$0.12 today');
  });

  it('includes error info in output when eval-opt has errors', async () => {
    mockRunEvalOptLoop.mockResolvedValueOnce(makeEvalOptResult({
      errors: ['Haiku timeout on iteration 2'],
    }));

    const result = await handlers['daily_briefing']({});
    const text = result.content[0].text;

    expect(text).toContain('**ERRORS:**');
    expect(text).toContain('Haiku timeout on iteration 2');
  });
});

// ─── Deferred items ─────────────────────────────────────────────────────────

describe('deferred items', () => {
  it('auto-populates deferred context from deferred.json', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      items: [
        { title: 'Fix RLS policy', effort: 'small', sprintPhase: 'Phase 50', resolved: false },
        { title: 'Refactor auth', effort: 'medium', sprintPhase: 'Phase 48', resolved: false },
        { title: 'Done item', effort: 'small', sprintPhase: 'Phase 45', resolved: true },
      ],
    }));

    await handlers['daily_briefing']({});

    const prompt = mockRunEvalOptLoop.mock.calls[0][0];
    expect(prompt).toContain('Tech Debt');
    expect(prompt).toContain('2 items'); // 2 unresolved
    expect(prompt).toContain('Fix RLS policy');
    expect(prompt).toContain('Refactor auth');
  });

  it('skips deferred context when deferred_context is "none"', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      items: [{ title: 'Something', effort: 'small', sprintPhase: 'Phase 1', resolved: false }],
    }));

    await handlers['daily_briefing']({ deferred_context: 'none' });

    const prompt = mockRunEvalOptLoop.mock.calls[0][0];
    expect(prompt).not.toContain('Tech Debt');
  });

  it('uses provided deferred_context instead of auto-loading', async () => {
    await handlers['daily_briefing']({ deferred_context: '3 items: auth refactor, RLS, tests' });

    const prompt = mockRunEvalOptLoop.mock.calls[0][0];
    expect(prompt).toContain('3 items: auth refactor, RLS, tests');
  });

  it('handles missing deferred.json gracefully', async () => {
    mockExistsSync.mockReturnValue(false);

    await handlers['daily_briefing']({});

    // Should not throw and prompt should not contain Tech Debt section
    const prompt = mockRunEvalOptLoop.mock.calls[0][0];
    expect(prompt).not.toContain('Tech Debt');
  });
});

// ─── Gmail delivery (daily) ─────────────────────────────────────────────────

describe('daily briefing Gmail delivery', () => {
  it('sends briefing via Gmail when deliver_via_gmail=true', async () => {
    const result = await handlers['daily_briefing']({ deliver_via_gmail: true });
    const text = result.content[0].text;

    expect(mockSendGmail).toHaveBeenCalledTimes(1);
    expect(mockSendGmail).toHaveBeenCalledWith({
      to: 'founder@radl.solutions',
      subject: expect.stringContaining('Daily Briefing'),
      htmlBody: expect.stringContaining('<!DOCTYPE html>'),
    });
    expect(text).toContain('Sent via Gmail');
  });

  it('uses custom recipient when provided', async () => {
    await handlers['daily_briefing']({
      deliver_via_gmail: true,
      recipient: 'custom@example.com',
    });

    expect(mockSendGmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'custom@example.com' }),
    );
  });

  it('does not send when deliver_via_gmail is not set', async () => {
    await handlers['daily_briefing']({});

    expect(mockSendGmail).not.toHaveBeenCalled();
  });

  it('reports when Google is not configured', async () => {
    mockIsGoogleConfigured.mockReturnValue(false);

    const result = await handlers['daily_briefing']({ deliver_via_gmail: true });
    const text = result.content[0].text;

    expect(text).toContain('Gmail delivery skipped');
    expect(text).toContain('not configured');
    expect(mockSendGmail).not.toHaveBeenCalled();
  });

  it('reports Gmail send failure without throwing', async () => {
    mockSendGmail.mockRejectedValueOnce(new Error('Rate limit exceeded'));

    const result = await handlers['daily_briefing']({ deliver_via_gmail: true });
    const text = result.content[0].text;

    expect(text).toContain('Gmail delivery failed');
    expect(text).toContain('Rate limit exceeded');
  });
});

// ─── Weekly Briefing ────────────────────────────────────────────────────────

describe('weekly_briefing', () => {
  it('calls runEvalOptLoop with weekly prompt and date range', async () => {
    const result = await handlers['weekly_briefing']({
      week_start: '2026-02-12',
    });
    const text = result.content[0].text;

    expect(mockRunEvalOptLoop).toHaveBeenCalledTimes(1);
    const prompt = mockRunEvalOptLoop.mock.calls[0][0];
    expect(prompt).toContain('2026-02-12');
    expect(prompt).toContain('comprehensive weekly briefing');
    expect(text).toContain('Daily Briefing'); // from the default eval-opt mock output
  });

  it('defaults week_start to 7 days ago when not provided', async () => {
    await handlers['weekly_briefing']({});

    const prompt = mockRunEvalOptLoop.mock.calls[0][0];
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    expect(prompt).toContain(sevenDaysAgo);
  });

  it('includes github_context and monitoring_context in weekly prompt', async () => {
    await handlers['weekly_briefing']({
      github_context: '15 PRs merged, 8 issues closed',
      monitoring_context: '99.9% uptime, 2 incidents',
    });

    const prompt = mockRunEvalOptLoop.mock.calls[0][0];
    expect(prompt).toContain('15 PRs merged');
    expect(prompt).toContain('99.9% uptime');
  });

  it('sends weekly briefing via Gmail when requested', async () => {
    await handlers['weekly_briefing']({
      deliver_via_gmail: true,
      week_start: '2026-02-12',
    });

    expect(mockSendGmail).toHaveBeenCalledWith({
      to: 'founder@radl.solutions',
      subject: expect.stringContaining('Weekly Briefing'),
      htmlBody: expect.stringContaining('<!DOCTYPE html>'),
    });
  });

  it('uses weekly-specific evaluation criteria', async () => {
    await handlers['weekly_briefing']({});

    const evalOptArgs = mockRunEvalOptLoop.mock.calls[0][1];
    expect(evalOptArgs.evaluationCriteria).toEqual(
      expect.arrayContaining([expect.stringContaining('Strategic insight')]),
    );
  });

  it('includes deferred items in weekly prompt', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      items: [
        { title: 'Old debt', effort: 'large', sprintPhase: 'Phase 30', resolved: false },
      ],
    }));

    await handlers['weekly_briefing']({});

    const prompt = mockRunEvalOptLoop.mock.calls[0][0];
    expect(prompt).toContain('Tech Debt Backlog');
    expect(prompt).toContain('Old debt');
  });
});

// ─── Roadmap Ideas ──────────────────────────────────────────────────────────

describe('roadmap_ideas', () => {
  it('returns generated feature ideas', async () => {
    const result = await handlers['roadmap_ideas']({});
    const text = result.content[0].text;

    expect(text).toContain('Feature Ideas');
    expect(text).toContain('Attendance tracking');
  });

  it('includes focus_area in prompt when provided', async () => {
    await handlers['roadmap_ideas']({ focus_area: 'athlete experience' });

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: expect.stringContaining('athlete experience') }],
      }),
    );
  });

  it('includes constraint in prompt when provided', async () => {
    await handlers['roadmap_ideas']({ constraint: 'launch in 2 months' });

    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: expect.stringContaining('launch in 2 months') }],
      }),
    );
  });

  it('handles API error gracefully', async () => {
    mockMessagesCreate.mockRejectedValueOnce(new Error('API rate limit'));

    const result = await handlers['roadmap_ideas']({});
    const text = result.content[0].text;

    expect(text).toContain('ERROR');
    expect(text).toContain('API rate limit');
  });
});
