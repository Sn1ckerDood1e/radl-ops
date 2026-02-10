import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing module under test
vi.mock('../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(),
}));

vi.mock('../models/token-tracker.js', () => ({
  trackUsage: vi.fn(),
}));

vi.mock('../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { runEvalOptLoop } from './evaluator-optimizer.js';
import { getAnthropicClient } from '../config/anthropic.js';
import type { EvalOptConfig } from './evaluator-optimizer.js';

function makeMessage(text: string, inputTokens = 100, outputTokens = 50) {
  return {
    content: [{ type: 'text' as const, text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function makeEvalJson(score: number, passed: boolean, feedback = 'Good') {
  return JSON.stringify({
    score,
    passed,
    feedback,
    strengths: ['clear'],
    weaknesses: score < 7 ? ['needs improvement'] : [],
  });
}

const baseConfig: EvalOptConfig = {
  generatorTaskType: 'briefing',
  evaluatorTaskType: 'review',
  qualityThreshold: 7,
  maxIterations: 3,
  evaluationCriteria: ['Completeness', 'Accuracy'],
};

describe('Evaluator-Optimizer Loop', () => {
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn();
    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: mockCreate },
    } as unknown as ReturnType<typeof getAnthropicClient>);
  });

  it('converges on first try when score meets threshold', async () => {
    // Generator response
    mockCreate.mockResolvedValueOnce(makeMessage('Great briefing content'));
    // Evaluator response (score 8 >= threshold 7)
    mockCreate.mockResolvedValueOnce(makeMessage(makeEvalJson(8, true)));

    const result = await runEvalOptLoop('Generate a briefing', baseConfig);

    expect(result.converged).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.finalScore).toBe(8);
    expect(result.finalOutput).toBe('Great briefing content');
    expect(result.evaluations).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it('iterates when first score is below threshold', async () => {
    // Iteration 1: generator + evaluator (score 5)
    mockCreate.mockResolvedValueOnce(makeMessage('Draft v1'));
    mockCreate.mockResolvedValueOnce(makeMessage(makeEvalJson(5, false, 'Needs more detail')));
    // Iteration 2: generator + evaluator (score 8)
    mockCreate.mockResolvedValueOnce(makeMessage('Draft v2 improved'));
    mockCreate.mockResolvedValueOnce(makeMessage(makeEvalJson(8, true)));

    const result = await runEvalOptLoop('Generate a briefing', baseConfig);

    expect(result.converged).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.finalOutput).toBe('Draft v2 improved');
    expect(result.evaluations).toHaveLength(2);
  });

  it('returns non-converged result when max iterations reached', async () => {
    // All 3 iterations score below threshold
    for (let i = 0; i < 3; i++) {
      mockCreate.mockResolvedValueOnce(makeMessage(`Draft v${i + 1}`));
      mockCreate.mockResolvedValueOnce(makeMessage(makeEvalJson(4, false)));
    }

    const result = await runEvalOptLoop('Generate a briefing', baseConfig);

    expect(result.converged).toBe(false);
    expect(result.iterations).toBe(3);
    expect(result.finalScore).toBe(4);
    expect(result.evaluations).toHaveLength(3);
  });

  it('handles generator API failure gracefully', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API rate limit'));

    const result = await runEvalOptLoop('Generate a briefing', baseConfig);

    expect(result.converged).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Generator failed');
    expect(result.errors[0]).toContain('API rate limit');
    expect(result.finalOutput).toBe('');
  });

  it('handles evaluator API failure gracefully', async () => {
    mockCreate.mockResolvedValueOnce(makeMessage('Good content'));
    mockCreate.mockRejectedValueOnce(new Error('Evaluator timeout'));

    const result = await runEvalOptLoop('Generate a briefing', baseConfig);

    expect(result.converged).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Evaluator failed');
    expect(result.errors[0]).toContain('Evaluator timeout');
    expect(result.finalOutput).toBe('Good content');
  });

  it('tracks total cost across iterations', async () => {
    mockCreate.mockResolvedValueOnce(makeMessage('Content', 500, 200));
    mockCreate.mockResolvedValueOnce(makeMessage(makeEvalJson(9, true), 300, 100));

    const result = await runEvalOptLoop('Generate a briefing', baseConfig);

    expect(result.totalCostUsd).toBeGreaterThan(0);
    expect(result.converged).toBe(true);
  });

  it('uses default config values when not specified', async () => {
    mockCreate.mockResolvedValueOnce(makeMessage('Content'));
    mockCreate.mockResolvedValueOnce(makeMessage(makeEvalJson(8, true)));

    const minConfig: EvalOptConfig = {
      generatorTaskType: 'conversation',
      evaluationCriteria: ['Quality'],
    };

    const result = await runEvalOptLoop('Generate something', minConfig);
    expect(result.converged).toBe(true);
  });

  describe('parseEvalResponse (tested via runEvalOptLoop)', () => {
    it('parses valid JSON evaluation', async () => {
      mockCreate.mockResolvedValueOnce(makeMessage('Content'));
      mockCreate.mockResolvedValueOnce(makeMessage(makeEvalJson(9, true, 'Excellent')));

      const result = await runEvalOptLoop('Test', baseConfig);

      expect(result.evaluations[0].score).toBe(9);
      expect(result.evaluations[0].feedback).toBe('Excellent');
      expect(result.evaluations[0].strengths).toContain('clear');
    });

    it('falls back to heuristic when JSON is invalid', async () => {
      mockCreate.mockResolvedValueOnce(makeMessage('Content'));
      mockCreate.mockResolvedValueOnce(makeMessage('Overall score: 8/10. Nice work.'));

      const result = await runEvalOptLoop('Test', baseConfig);

      expect(result.evaluations[0].score).toBe(8);
      expect(result.converged).toBe(true);
    });

    it('defaults to score 5 when no score pattern found', async () => {
      mockCreate.mockResolvedValueOnce(makeMessage('Content'));
      mockCreate.mockResolvedValueOnce(makeMessage('This is decent work without a numeric score.'));
      // After score 5 (below threshold 7), second iteration
      mockCreate.mockResolvedValueOnce(makeMessage('Better content'));
      mockCreate.mockResolvedValueOnce(makeMessage(makeEvalJson(8, true)));

      const result = await runEvalOptLoop('Test', baseConfig);

      expect(result.evaluations[0].score).toBe(5);
      expect(result.evaluations[0].weaknesses).toContain('Unable to parse structured evaluation');
    });
  });
});
