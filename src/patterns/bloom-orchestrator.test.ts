import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing module under test
vi.mock('../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(),
}));

vi.mock('../models/token-tracker.js', () => ({
  trackUsage: vi.fn(),
}));

vi.mock('../models/router.js', () => ({
  getRoute: vi.fn(),
  calculateCost: vi.fn(),
}));

vi.mock('../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../utils/retry.js', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../knowledge/graph.js', () => ({
  addNodes: vi.fn(),
  addEdges: vi.fn(),
}));

import { runBloomPipeline, extractAndStoreEntities } from './bloom-orchestrator.js';
import { addNodes, addEdges } from '../knowledge/graph.js';
import type { SprintData } from './bloom-orchestrator.js';
import { getAnthropicClient } from '../config/anthropic.js';
import { getRoute, calculateCost } from '../models/router.js';
import { withRetry } from '../utils/retry.js';

const mockSprintData: SprintData = {
  phase: 'Phase 80',
  title: 'Test Sprint',
  status: 'complete',
  completedTasks: ['Task 1', 'Task 2'],
  blockers: [],
  estimate: '2 hours',
  actual: '1.5 hours',
};

function makeTextMessage(text: string, inputTokens = 100, outputTokens = 50) {
  return {
    content: [{ type: 'text' as const, text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function makeToolMessage(toolName: string, toolInput: unknown, inputTokens = 100, outputTokens = 50) {
  return {
    content: [{
      type: 'tool_use' as const,
      id: 'toolu_test',
      name: toolName,
      input: toolInput,
    }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

describe('Bloom Pipeline', () => {
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn();
    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: mockCreate },
    } as unknown as ReturnType<typeof getAnthropicClient>);

    // Mock getRoute to return ModelRoute objects
    vi.mocked(getRoute).mockImplementation((taskType) => {
      if (taskType === 'spot_check') {
        return {
          model: 'claude-haiku-4-5-20251001' as const,
          effort: 'low' as const,
          maxTokens: 1024,
          inputCostPer1M: 0.80,
          outputCostPer1M: 4,
        };
      }
      return {
        model: 'claude-sonnet-4-5-20250929' as const,
        effort: 'high' as const,
        maxTokens: 4096,
        inputCostPer1M: 3,
        outputCostPer1M: 15,
      };
    });

    // Mock calculateCost to return small cost
    vi.mocked(calculateCost).mockReturnValue(0.001);
  });

  it('completes full pipeline successfully with structured outputs', async () => {
    // Stage 1: Understanding (text)
    mockCreate.mockResolvedValueOnce(makeTextMessage('Sprint analysis: tasks completed on time'));
    // Stage 2: Ideation (text)
    mockCreate.mockResolvedValueOnce(makeTextMessage('Candidate insights generated'));
    // Stage 3: Rollout (structured tool_use)
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_lessons', {
      lessons: [
        { category: 'pattern', content: 'Use TDD for all features', confidence: 8 },
        { category: 'lesson', content: 'Estimate time conservatively', confidence: 7 },
      ],
    }));
    // Stage 4: Judgment (structured tool_use)
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_judgment', {
      score: 8,
      feedback: 'High quality insights',
      keep: [0, 1],
      drop: [],
    }));

    const result = await runBloomPipeline(mockSprintData);

    expect(result.lessons).toHaveLength(2);
    expect(result.lessons[0].category).toBe('pattern');
    expect(result.lessons[0].content).toBe('Use TDD for all features');
    expect(result.qualityScore).toBe(8);
    expect(result.failedAtStage).toBeUndefined();
    expect(mockCreate).toHaveBeenCalledTimes(4);
  });

  it('short-circuits pipeline on stage failure and returns qualityScore 0', async () => {
    // Stage 1: Understanding succeeds
    mockCreate.mockResolvedValueOnce(makeTextMessage('Sprint analysis'));
    // Stage 2: Ideation fails
    mockCreate.mockRejectedValueOnce(new Error('API timeout'));

    const result = await runBloomPipeline(mockSprintData);

    expect(result.qualityScore).toBe(0);
    expect(result.failedAtStage).toBe('ideation');
    expect(result.lessons).toHaveLength(0);
    expect(result.stageOutputs.understanding).toBe('Sprint analysis');
    expect(result.stageOutputs.ideation).toBe('');
    expect(result.stageOutputs.rollout).toBe('');
    expect(result.stageOutputs.judgment).toBe('');
    // Only 2 stages should have been attempted (understanding + ideation)
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('retries on transient failures via withRetry', async () => {
    // Setup: first call fails, retry succeeds
    mockCreate
      .mockRejectedValueOnce(new Error('Rate limit'))
      .mockResolvedValueOnce(makeTextMessage('Understanding after retry'))
      .mockResolvedValueOnce(makeTextMessage('Ideation'))
      .mockResolvedValueOnce(makeToolMessage('submit_lessons', { lessons: [] }))
      .mockResolvedValueOnce(makeToolMessage('submit_judgment', { score: 5, feedback: 'OK' }));

    // Mock withRetry to actually retry once
    vi.mocked(withRetry).mockImplementation(async (fn) => {
      try {
        return await fn();
      } catch {
        // Retry once
        return await fn();
      }
    });

    const result = await runBloomPipeline(mockSprintData);

    expect(result.failedAtStage).toBeUndefined();
    expect(result.stageOutputs.understanding).toBe('Understanding after retry');
    // withRetry should have been called 4 times (once per stage)
    expect(withRetry).toHaveBeenCalledTimes(4);
  });

  it('parses structured rollout output correctly', async () => {
    mockCreate.mockResolvedValueOnce(makeTextMessage('Understanding'));
    mockCreate.mockResolvedValueOnce(makeTextMessage('Ideation'));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_lessons', {
      lessons: [
        { category: 'pattern', content: 'Pattern A', confidence: 9 },
        { category: 'lesson', content: 'Lesson B', confidence: 6 },
        { category: 'decision', content: 'Decision C', confidence: 8 },
      ],
    }));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_judgment', {
      score: 7,
      feedback: 'Good',
    }));

    const result = await runBloomPipeline(mockSprintData);

    expect(result.lessons).toHaveLength(3);
    expect(result.lessons[0].category).toBe('pattern');
    expect(result.lessons[0].confidence).toBe(9);
    expect(result.lessons[1].category).toBe('lesson');
    expect(result.lessons[2].category).toBe('decision');
  });

  it('extracts quality score from judgment tool_use block', async () => {
    mockCreate.mockResolvedValueOnce(makeTextMessage('Understanding'));
    mockCreate.mockResolvedValueOnce(makeTextMessage('Ideation'));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_lessons', {
      lessons: [{ category: 'pattern', content: 'Test', confidence: 8 }],
    }));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_judgment', {
      score: 9,
      feedback: 'Excellent insights',
      keep: [0],
    }));

    const result = await runBloomPipeline(mockSprintData);

    expect(result.qualityScore).toBe(9);
    expect(result.lessons).toHaveLength(1);
  });

  it('filters lessons based on judgment keep indices', async () => {
    mockCreate.mockResolvedValueOnce(makeTextMessage('Understanding'));
    mockCreate.mockResolvedValueOnce(makeTextMessage('Ideation'));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_lessons', {
      lessons: [
        { category: 'pattern', content: 'Keep this', confidence: 9 },
        { category: 'lesson', content: 'Drop this', confidence: 4 },
        { category: 'pattern', content: 'Keep this too', confidence: 8 },
      ],
    }));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_judgment', {
      score: 8,
      feedback: 'Filtered',
      keep: [0, 2], // Only first and third
    }));

    const result = await runBloomPipeline(mockSprintData);

    expect(result.lessons).toHaveLength(2);
    expect(result.lessons[0].content).toBe('Keep this');
    expect(result.lessons[1].content).toBe('Keep this too');
  });

  it('filters lessons based on judgment drop indices', async () => {
    mockCreate.mockResolvedValueOnce(makeTextMessage('Understanding'));
    mockCreate.mockResolvedValueOnce(makeTextMessage('Ideation'));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_lessons', {
      lessons: [
        { category: 'pattern', content: 'A', confidence: 9 },
        { category: 'lesson', content: 'B', confidence: 4 },
        { category: 'pattern', content: 'C', confidence: 8 },
      ],
    }));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_judgment', {
      score: 7,
      feedback: 'Dropped low quality',
      drop: [1], // Drop the middle one
    }));

    const result = await runBloomPipeline(mockSprintData);

    expect(result.lessons).toHaveLength(2);
    expect(result.lessons[0].content).toBe('A');
    expect(result.lessons[1].content).toBe('C');
  });

  it('handles partial pipeline completion (only 2 stages complete)', async () => {
    // Stage 1 and 2 succeed
    mockCreate.mockResolvedValueOnce(makeTextMessage('Understanding'));
    mockCreate.mockResolvedValueOnce(makeTextMessage('Ideation'));
    // Stage 3 fails
    mockCreate.mockRejectedValueOnce(new Error('Stage 3 failure'));

    const result = await runBloomPipeline(mockSprintData);

    expect(result.qualityScore).toBe(0);
    expect(result.failedAtStage).toBe('rollout');
    expect(result.lessons).toHaveLength(0);
    expect(result.stageOutputs.understanding).toBeTruthy();
    expect(result.stageOutputs.ideation).toBeTruthy();
    expect(result.stageOutputs.rollout).toBe('');
    expect(result.stageOutputs.judgment).toBe('');
  });

  it('accumulates cost across all stages', async () => {
    vi.mocked(calculateCost).mockReturnValue(0.002); // $0.002 per stage

    mockCreate.mockResolvedValueOnce(makeTextMessage('Understanding'));
    mockCreate.mockResolvedValueOnce(makeTextMessage('Ideation'));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_lessons', { lessons: [] }));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_judgment', { score: 6, feedback: 'OK' }));

    const result = await runBloomPipeline(mockSprintData);

    // 4 stages * $0.002 = $0.008
    expect(result.totalCostUsd).toBe(0.008);
  });

  it('uses getRoute() for model routing', async () => {
    mockCreate.mockResolvedValueOnce(makeTextMessage('Understanding'));
    mockCreate.mockResolvedValueOnce(makeTextMessage('Ideation'));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_lessons', { lessons: [] }));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_judgment', { score: 5, feedback: 'OK' }));

    await runBloomPipeline(mockSprintData);

    // getRoute should be called for spot_check and review task types
    expect(getRoute).toHaveBeenCalledWith('spot_check');
    expect(getRoute).toHaveBeenCalledWith('review');
  });

  it('passes existing knowledge to ideation stage', async () => {
    const existingKnowledge = 'Pattern: Always use TypeScript\nLesson: Test first';

    mockCreate.mockResolvedValueOnce(makeTextMessage('Understanding'));
    mockCreate.mockResolvedValueOnce(makeTextMessage('Ideation with context'));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_lessons', { lessons: [] }));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_judgment', { score: 6, feedback: 'OK' }));

    await runBloomPipeline(mockSprintData, existingKnowledge);

    // Check that the ideation call includes existing knowledge
    const ideationCall = mockCreate.mock.calls[1][0];
    expect(ideationCall.messages[0].content).toContain('Existing Knowledge Base');
    expect(ideationCall.messages[0].content).toContain('Always use TypeScript');
  });

  it('falls back to regex parsing when rollout has no tool_use block', async () => {
    mockCreate.mockResolvedValueOnce(makeTextMessage('Understanding'));
    mockCreate.mockResolvedValueOnce(makeTextMessage('Ideation'));
    // Stage 3 returns text with JSON array instead of tool_use
    mockCreate.mockResolvedValueOnce(makeTextMessage(JSON.stringify([
      { category: 'pattern', content: 'Fallback pattern', confidence: 7 },
    ])));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_judgment', {
      score: 6,
      feedback: 'OK',
    }));

    const result = await runBloomPipeline(mockSprintData);

    expect(result.lessons).toHaveLength(1);
    expect(result.lessons[0].content).toBe('Fallback pattern');
  });

  it('falls back to regex parsing when judgment has no tool_use block', async () => {
    mockCreate.mockResolvedValueOnce(makeTextMessage('Understanding'));
    mockCreate.mockResolvedValueOnce(makeTextMessage('Ideation'));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_lessons', {
      lessons: [{ category: 'pattern', content: 'Test', confidence: 8 }],
    }));
    // Stage 4 returns text with JSON instead of tool_use
    mockCreate.mockResolvedValueOnce(makeTextMessage(JSON.stringify({
      score: 7,
      feedback: 'Good work',
    })));

    const result = await runBloomPipeline(mockSprintData);

    expect(result.qualityScore).toBe(7);
  });

  it('handles malformed lessons gracefully', async () => {
    mockCreate.mockResolvedValueOnce(makeTextMessage('Understanding'));
    mockCreate.mockResolvedValueOnce(makeTextMessage('Ideation'));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_lessons', {
      lessons: [
        { category: 'pattern', content: 'Valid lesson', confidence: 8 },
        { category: 'invalid', content: null, confidence: 5 }, // Invalid
        { content: 'Missing category', confidence: 7 }, // Missing category
      ],
    }));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_judgment', {
      score: 6,
      feedback: 'OK',
    }));

    const result = await runBloomPipeline(mockSprintData);

    // Should only include valid lessons
    expect(result.lessons).toHaveLength(1);
    expect(result.lessons[0].content).toBe('Valid lesson');
  });

  it('defaults to score 5 when judgment parsing fails completely', async () => {
    mockCreate.mockResolvedValueOnce(makeTextMessage('Understanding'));
    mockCreate.mockResolvedValueOnce(makeTextMessage('Ideation'));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_lessons', {
      lessons: [{ category: 'pattern', content: 'Test', confidence: 8 }],
    }));
    // Stage 4 returns unparseable text
    mockCreate.mockResolvedValueOnce(makeTextMessage('The lessons look pretty good overall.'));

    const result = await runBloomPipeline(mockSprintData);

    expect(result.qualityScore).toBe(5);
    expect(result.lessons).toHaveLength(1);
  });

  it('calls entity extraction after successful pipeline', async () => {
    mockCreate.mockResolvedValueOnce(makeTextMessage('Understanding'));
    mockCreate.mockResolvedValueOnce(makeTextMessage('Ideation'));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_lessons', {
      lessons: [
        { category: 'pattern', content: 'Use CSRF headers always', confidence: 8 },
        { category: 'lesson', content: 'Never use listUsers for single lookup', confidence: 9 },
      ],
    }));
    mockCreate.mockResolvedValueOnce(makeToolMessage('submit_judgment', {
      score: 8,
      feedback: 'Good insights',
    }));

    await runBloomPipeline(mockSprintData);

    // Entity extraction should have been called
    expect(addNodes).toHaveBeenCalled();
    expect(addEdges).toHaveBeenCalled();
  });
});

describe('Entity Extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates sprint + lesson + concept nodes', () => {
    const result = extractAndStoreEntities(
      [{ category: 'pattern', content: 'Always use CSRF protection headers', confidence: 8 }],
      'Phase 110',
    );

    expect(result.nodesAdded).toBeGreaterThan(0);
    expect(result.edgesAdded).toBeGreaterThan(0);
    expect(addNodes).toHaveBeenCalled();
    expect(addEdges).toHaveBeenCalled();
  });

  it('returns zeros for empty lessons', () => {
    const result = extractAndStoreEntities([], 'Phase 110');
    expect(result.nodesAdded).toBe(0);
    expect(result.edgesAdded).toBe(0);
  });

  it('creates co-occurrence edges between concepts', () => {
    extractAndStoreEntities(
      [{ category: 'lesson', content: 'Authentication and CSRF protection are related security concerns', confidence: 7 }],
      'Phase 110',
    );

    const edgeCalls = vi.mocked(addEdges).mock.calls;
    expect(edgeCalls.length).toBeGreaterThan(0);

    // Should have co_occurs edges between concepts
    const allEdges = edgeCalls.flatMap(call => call[0]);
    const coOccurs = allEdges.filter(e => e.relationship === 'co_occurs');
    expect(coOccurs.length).toBeGreaterThan(0);
  });

  it('extracts PascalCase identifiers as concepts', () => {
    extractAndStoreEntities(
      [{ category: 'pattern', content: 'Use SprintConductor for orchestration', confidence: 8 }],
      'Phase 110',
    );

    const nodeCalls = vi.mocked(addNodes).mock.calls;
    const allNodes = nodeCalls.flatMap(call => call[0]);
    const conceptNodes = allNodes.filter(n => n.type === 'concept');
    const labels = conceptNodes.map(n => n.label);
    expect(labels).toContain('sprintconductor');
  });

  it('limits concepts to 8 per lesson', () => {
    extractAndStoreEntities(
      [{ category: 'lesson', content: 'authentication authorization validation serialization deserialization optimization internationalization localization configuration initialization verification specification implementation', confidence: 5 }],
      'Phase 110',
    );

    const nodeCalls = vi.mocked(addNodes).mock.calls;
    const allNodes = nodeCalls.flatMap(call => call[0]);
    const conceptNodes = allNodes.filter(n => n.type === 'concept');
    // Should be limited to 8 concepts max per lesson
    expect(conceptNodes.length).toBeLessThanOrEqual(8);
  });
});
