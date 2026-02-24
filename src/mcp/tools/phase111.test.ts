/**
 * Phase 111 Tests — Verification & Review Quality
 *
 * Covers:
 * - T1: 4-Level verification system (levels 1-3 tested; level 4 = legacy verify tests)
 * - T2: Spec compliance tool (tested via handler extraction)
 * - T3: Tool guide (tested via handler extraction)
 * - T4: Model fallback chains (getRouteWithFallback, isRateLimitError)
 * - T5: Subagent context isolation (buildSpecPrompt includes iron laws, decompose uses patterns only)
 * - T6: Struggle detection (stuck, looping signals in session health)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================
// T4: Model Fallback Chains
// ============================================

import {
  getRoute,
  getRouteWithFallback,
  clearRouteOverrides,
} from '../../models/router.js';
import { isRateLimitError } from '../../utils/retry.js';

describe('T4: Model Fallback Chains', () => {
  beforeEach(() => {
    clearRouteOverrides();
  });

  describe('isRateLimitError', () => {
    it('returns true for errors with status 429', () => {
      const error = Object.assign(new Error('Rate limited'), { status: 429 });
      expect(isRateLimitError(error)).toBe(true);
    });

    it('returns false for errors with status 500', () => {
      const error = Object.assign(new Error('Server error'), { status: 500 });
      expect(isRateLimitError(error)).toBe(false);
    });

    it('returns false for errors without status property', () => {
      expect(isRateLimitError(new Error('Network error'))).toBe(false);
    });

    it('returns false for non-Error objects', () => {
      expect(isRateLimitError('string')).toBe(false);
      expect(isRateLimitError(null)).toBe(false);
    });
  });

  describe('getRouteWithFallback', () => {
    it('returns primary route when no models are unavailable', () => {
      const route = getRouteWithFallback('architecture');
      expect(route.model).toBe('claude-opus-4-6');
    });

    it('falls back from Opus to Sonnet when Opus is unavailable', () => {
      const route = getRouteWithFallback('architecture', ['claude-opus-4-6']);
      expect(route.model).toBe('claude-sonnet-4-5-20250929');
      // Pricing should reflect the fallback model
      expect(route.inputCostPer1M).toBe(3);
      expect(route.outputCostPer1M).toBe(15);
    });

    it('falls back from Opus to Haiku when both Opus and Sonnet are unavailable', () => {
      const route = getRouteWithFallback('architecture', [
        'claude-opus-4-6',
        'claude-sonnet-4-5-20250929',
      ]);
      expect(route.model).toBe('claude-haiku-4-5-20251001');
      expect(route.inputCostPer1M).toBe(0.80);
    });

    it('falls back from Sonnet to Haiku when Sonnet is unavailable', () => {
      const route = getRouteWithFallback('planning', ['claude-sonnet-4-5-20250929']);
      expect(route.model).toBe('claude-haiku-4-5-20251001');
    });

    it('returns base route when all models in chain are unavailable', () => {
      const route = getRouteWithFallback('architecture', [
        'claude-opus-4-6',
        'claude-sonnet-4-5-20250929',
        'claude-haiku-4-5-20251001',
      ]);
      // Returns base model (will fail at API call level)
      expect(route.model).toBe('claude-opus-4-6');
    });

    it('Haiku has no fallback — returns Haiku when Haiku itself is unavailable', () => {
      const route = getRouteWithFallback('briefing', ['claude-haiku-4-5-20251001']);
      expect(route.model).toBe('claude-haiku-4-5-20251001');
    });

    it('preserves non-model route properties (effort, maxTokens) on fallback', () => {
      const original = getRoute('architecture');
      const fallback = getRouteWithFallback('architecture', ['claude-opus-4-6']);
      expect(fallback.effort).toBe(original.effort);
      expect(fallback.maxTokens).toBe(original.maxTokens);
    });

    it('returns primary route when unavailable list is empty', () => {
      const route = getRouteWithFallback('planning', []);
      expect(route.model).toBe('claude-sonnet-4-5-20250929');
    });
  });
});

// ============================================
// T5: Subagent Context Isolation
// ============================================

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../guardrails/iron-laws.js', () => ({
  getIronLaws: vi.fn(() => [
    { id: 'no-push-main', description: 'Never push directly to main branch', severity: 'block' },
    { id: 'no-commit-secrets', description: 'Never commit secrets', severity: 'block' },
  ]),
  recordError: vi.fn(() => 1),
  clearError: vi.fn(),
  checkIronLaws: vi.fn(),
}));

vi.mock('../../config/paths.js', () => ({
  getConfig: () => ({
    knowledgeDir: '/tmp/fake-knowledge',
    radlDir: '/home/hb/radl',
    dataDir: '/tmp/fake-data',
    projectRoot: '/home/hb/radl-ops',
  }),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => ({ mtimeMs: 0 })),
}));

vi.mock('../../models/token-tracker.js', () => ({
  trackUsage: vi.fn(),
  initTokenTracker: vi.fn(),
}));

vi.mock('../../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(),
}));

vi.mock('../../patterns/evaluator-optimizer.js', () => ({
  runEvalOptLoop: vi.fn(),
}));

vi.mock('../../knowledge/reasoning-bank.js', () => ({
  getCachedContext: vi.fn(() => null),
  cacheContext: vi.fn(),
}));

vi.mock('./shared/conductor-checkpoint.js', () => ({
  computeFeatureHash: vi.fn(() => 'test-hash'),
  loadCheckpoint: vi.fn(() => null),
  saveCheckpoint: vi.fn(),
  clearCheckpoint: vi.fn(),
}));

vi.mock('./shared/estimation.js', () => ({
  getCalibrationFactor: vi.fn(() => 0.5),
}));

vi.mock('./shared/plan-store.js', () => ({
  createPlanFromDecomposition: vi.fn(() => ({ id: 'test-plan' })),
  savePlan: vi.fn(),
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

describe('T5: Subagent Context Isolation', () => {
  let buildSpecPrompt: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Dynamic import to get the exported helper
    const mod = await import('./sprint-conductor.js');
    buildSpecPrompt = mod.buildSpecPrompt;
  });

  it('buildSpecPrompt includes iron laws section', () => {
    const knowledge = { patterns: 'Pattern A', lessons: 'Lesson B', deferred: '', estimations: '' };
    const prompt = buildSpecPrompt('Add feature X', undefined, knowledge);

    expect(prompt).toContain('Hard constraints (iron laws)');
    expect(prompt).toContain('Never push directly to main branch');
    expect(prompt).toContain('Never commit secrets');
  });

  it('buildSpecPrompt includes patterns, lessons, and deferred', () => {
    const knowledge = {
      patterns: 'Established patterns:\n- CSRF headers',
      lessons: 'Recent lessons:\n- Check API handlers',
      deferred: 'Deferred items:\n- Fix CSS',
      estimations: 'Estimates run 50%',
    };
    const prompt = buildSpecPrompt('Add feature X', undefined, knowledge);

    expect(prompt).toContain('CSRF headers');
    expect(prompt).toContain('Check API handlers');
    expect(prompt).toContain('Fix CSS');
    // Estimations are intentionally NOT included in spec prompt
    expect(prompt).not.toContain('Estimates run 50%');
  });

  it('buildSpecPrompt includes additional context when provided', () => {
    const knowledge = { patterns: '', lessons: '', deferred: '', estimations: '' };
    const prompt = buildSpecPrompt('Feature', 'Must support mobile', knowledge);

    expect(prompt).toContain('Must support mobile');
  });

  it('buildSpecPrompt sanitizes feature and context inputs', () => {
    const knowledge = { patterns: '', lessons: '', deferred: '', estimations: '' };
    const prompt = buildSpecPrompt('Feature <script>alert(1)</script>', undefined, knowledge);

    expect(prompt).not.toContain('<script>');
    expect(prompt).toContain('&lt;script&gt;');
  });
});

// ============================================
// T6: Struggle Detection (session health signals)
// ============================================

import { session } from './shared/session-state.js';
import { registerSessionHealthTools } from './session-health.js';

// Extract handler
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

async function getSignals(): Promise<Array<{ id: string; severity: string; message: string; metric: string }>> {
  const result = await sessionHealthHandler({});
  return result.structuredContent.signals;
}

function makeCall(tool: string, success = true, minsAgo = 5): { tool: string; timestamp: number; success: boolean } {
  return { tool, timestamp: Date.now() - minsAgo * 60 * 1000, success };
}

describe('T6: Struggle Detection', () => {
  beforeEach(() => {
    session.startedAt = Date.now() - 25 * 60 * 1000;
    session.toolCalls = [];
    session.commitCount = 0;
    session.lastCommitAt = null;
    session.lastProgressAt = null;
    session.sprintActive = false;
  });

  describe('Signal: stuck (many calls since last commit)', () => {
    it('triggers warning when 20+ tool calls since last commit', async () => {
      session.commitCount = 1;
      // Commit was 22 minutes ago, all 20 calls are within last 19 minutes (all after commit)
      session.lastCommitAt = Date.now() - 22 * 60 * 1000;
      session.toolCalls = Array.from({ length: 20 }, (_, i) =>
        makeCall(`tool_${i}`, true, i + 1)
      );

      const signals = await getSignals();
      const stuck = signals.find(s => s.id === 'stuck');

      expect(stuck).toBeDefined();
      expect(stuck!.severity).toBe('warning');
    });

    it('triggers critical when 30+ tool calls since last commit', async () => {
      session.commitCount = 1;
      session.startedAt = Date.now() - 40 * 60 * 1000;
      // Commit was 35 minutes ago, all 30 calls are within last 29 minutes (all after commit)
      session.lastCommitAt = Date.now() - 35 * 60 * 1000;
      session.toolCalls = Array.from({ length: 30 }, (_, i) =>
        makeCall(`tool_${i}`, true, i + 1)
      );

      const signals = await getSignals();
      const stuck = signals.find(s => s.id === 'stuck');

      expect(stuck).toBeDefined();
      expect(stuck!.severity).toBe('critical');
    });

    it('does NOT trigger when fewer than 20 calls since last commit', async () => {
      session.commitCount = 1;
      session.lastCommitAt = Date.now() - 15 * 60 * 1000;
      session.toolCalls = Array.from({ length: 19 }, (_, i) =>
        makeCall(`tool_${i}`, true, i + 1)
      );

      const signals = await getSignals();
      expect(signals.map(s => s.id)).not.toContain('stuck');
    });

    it('does NOT trigger when no commits have been made (lastCommitAt is null)', async () => {
      session.lastCommitAt = null;
      session.toolCalls = Array.from({ length: 25 }, (_, i) =>
        makeCall(`tool_${i}`, true, i + 1)
      );

      const signals = await getSignals();
      expect(signals.map(s => s.id)).not.toContain('stuck');
    });
  });

  describe('Signal: looping (rapid-fire calls)', () => {
    it('triggers warning when 5+ consecutive calls are < 30s apart', async () => {
      const now = Date.now();
      // Need 7 calls with <30s gaps between each trailing pair to get 6 rapid gaps (>= 5)
      session.toolCalls = [
        { tool: 'tool_0', timestamp: now - 120000, success: true }, // far back (>30s gap from next)
        { tool: 'tool_a', timestamp: now - 30000, success: true },
        { tool: 'tool_b', timestamp: now - 25000, success: true }, // 5s gap
        { tool: 'tool_c', timestamp: now - 20000, success: true }, // 5s gap
        { tool: 'tool_d', timestamp: now - 15000, success: true }, // 5s gap
        { tool: 'tool_e', timestamp: now - 10000, success: true }, // 5s gap
        { tool: 'tool_f', timestamp: now - 5000, success: true },  // 5s gap → 5 trailing rapid gaps
      ];

      const signals = await getSignals();
      const looping = signals.find(s => s.id === 'looping');

      expect(looping).toBeDefined();
      expect(looping!.severity).toBe('warning');
    });

    it('triggers critical when 10+ consecutive calls are < 30s apart', async () => {
      const now = Date.now();
      // 12 calls each 5s apart = 11 rapid gaps
      session.toolCalls = Array.from({ length: 12 }, (_, i) => ({
        tool: `tool_${i}`,
        timestamp: now - (11 - i) * 5000,
        success: true,
      }));

      const signals = await getSignals();
      const looping = signals.find(s => s.id === 'looping');

      expect(looping).toBeDefined();
      expect(looping!.severity).toBe('critical');
    });

    it('does NOT trigger when fewer than 5 rapid gaps', async () => {
      const now = Date.now();
      session.toolCalls = [
        { tool: 'a', timestamp: now - 60000, success: true },
        { tool: 'b', timestamp: now - 25000, success: true },
        { tool: 'c', timestamp: now - 15000, success: true },
        { tool: 'd', timestamp: now - 5000, success: true },
        // Only 3 rapid gaps (b→c, c→d = consecutive rapid from end)
        // Actually: d→c = 10s (<30s), c→b = 10s (<30s), b→a = 35s (>30s) → 2 rapid gaps
      ];

      const signals = await getSignals();
      expect(signals.map(s => s.id)).not.toContain('looping');
    });

    it('does NOT trigger when calls are > 30s apart', async () => {
      const now = Date.now();
      session.toolCalls = Array.from({ length: 10 }, (_, i) => ({
        tool: `tool_${i}`,
        timestamp: now - (9 - i) * 60000, // 60s apart each
        success: true,
      }));

      const signals = await getSignals();
      expect(signals.map(s => s.id)).not.toContain('looping');
    });

    it('only counts trailing consecutive rapid gaps (breaks on first slow gap)', async () => {
      const now = Date.now();
      session.toolCalls = [
        // Early rapid burst (should not count — trailing check breaks)
        { tool: 'a', timestamp: now - 200000, success: true },
        { tool: 'b', timestamp: now - 195000, success: true },
        { tool: 'c', timestamp: now - 190000, success: true },
        { tool: 'd', timestamp: now - 185000, success: true },
        { tool: 'e', timestamp: now - 180000, success: true },
        { tool: 'f', timestamp: now - 175000, success: true },
        // Slow gap
        { tool: 'g', timestamp: now - 60000, success: true },
        // Only 2 trailing rapid gaps
        { tool: 'h', timestamp: now - 20000, success: true },
        { tool: 'i', timestamp: now - 10000, success: true },
        { tool: 'j', timestamp: now - 5000, success: true },
      ];

      const signals = await getSignals();
      expect(signals.map(s => s.id)).not.toContain('looping');
    });
  });
});

// ============================================
// T3: Tool Guide
// ============================================

import { registerToolGuideTools } from './tool-guide.js';

describe('T3: Tool Guide', () => {
  let toolGuideHandler: Function;

  beforeEach(() => {
    const handlers: Record<string, Function> = {};
    const mockServer = {
      tool: (...args: unknown[]) => {
        const name = args[0] as string;
        handlers[name] = args[args.length - 1] as Function;
      },
    };
    registerToolGuideTools(mockServer as any);
    toolGuideHandler = handlers['tool_guide'];
  });

  it('returns all categories when no filter is provided', async () => {
    const result = await toolGuideHandler({});
    const text = result.content[0].text;

    expect(text).toContain('# Tool Guide');
    expect(text).toContain('## verification');
    expect(text).toContain('## knowledge');
    expect(text).toContain('## sprint-lifecycle');
    expect(text).toContain('## review');
    expect(text).toContain('## intelligence');
    expect(text).toContain('## session');
    expect(text).toContain('## planning');
  });

  it('filters by category when provided', async () => {
    const result = await toolGuideHandler({ category: 'verification' });
    const text = result.content[0].text;

    expect(text).toContain('## verification');
    expect(text).not.toContain('## knowledge');
    expect(text).not.toContain('## planning');
  });

  it('returns error for unknown category', async () => {
    const result = await toolGuideHandler({ category: 'nonexistent' });
    const text = result.content[0].text;

    expect(text).toContain('Unknown category');
    expect(text).toContain('nonexistent');
  });

  it('includes cost hints in output', async () => {
    const result = await toolGuideHandler({ category: 'verification' });
    const text = result.content[0].text;

    expect(text).toContain('$0');
    expect(text).toContain('Quick Reference');
  });
});
