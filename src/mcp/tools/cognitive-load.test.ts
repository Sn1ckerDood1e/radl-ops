import { describe, it, expect, vi, beforeEach } from 'vitest';

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

async function getHandler() {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
  };

  const { registerCognitiveLoadTools } = await import('./cognitive-load.js');
  registerCognitiveLoadTools(mockServer as any);
  return handlers['cognitive_load'];
}

describe('Cognitive Load Prediction Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers cognitive_load tool', async () => {
    const tools: string[] = [];
    const mockServer = {
      tool: (...args: unknown[]) => {
        tools.push(args[0] as string);
      },
    };

    const { registerCognitiveLoadTools } = await import('./cognitive-load.js');
    registerCognitiveLoadTools(mockServer as any);

    expect(tools).toContain('cognitive_load');
  });

  it('empty tasks returns safe status', async () => {
    const handler = await getHandler();
    const result = await handler({ remaining_tasks: [] });
    const text = result.content[0].text;

    expect(text).toContain('**Status:** SAFE');
    expect(text).toContain('No remaining tasks');
  });

  it('single small task returns safe', async () => {
    const handler = await getHandler();
    const result = await handler({
      remaining_tasks: [{
        title: 'Fix typo',
        description: 'Fix a small typo',
        type: 'fix',
      }],
      context_usage_percent: 10,
    });
    const text = result.content[0].text;

    expect(text).toContain('**Status:** SAFE');
    expect(text).toContain('Fix typo');
    expect(text).toContain('OK');
  });

  it('many large tasks with high context usage triggers critical', async () => {
    const handler = await getHandler();
    const largeTasks = Array.from({ length: 10 }, (_, i) => ({
      title: `Large feature ${i + 1}`,
      description: 'A '.repeat(150) + 'very complex feature that requires extensive implementation across multiple files and systems',
      type: 'feature',
      files: ['file1.ts', 'file2.ts', 'file3.ts', 'file4.ts', 'file5.ts'],
    }));

    const result = await handler({
      remaining_tasks: largeTasks,
      context_usage_percent: 70,
    });
    const text = result.content[0].text;

    expect(text).toContain('**Status:** CRITICAL');
    expect(text).toContain('OVERFLOW');
  });

  it('compaction point calculated correctly at warning threshold', async () => {
    const { estimateCognitiveLoad } = await import('./cognitive-load.js');

    // Start at 70% usage (140k tokens). Warning at 80% (160k tokens).
    // Each feature task ~8000 tokens base. Need enough to cross 160k.
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      title: `Task ${i + 1}`,
      description: 'A standard implementation task',
      type: 'feature',
    }));

    const result = estimateCognitiveLoad(tasks, 70);

    // Running totals should be: 140k + 8k = 148k, 156k, 164k (crosses 160k), 172k, 180k
    // Compaction point should be at the task before the first overflow
    expect(result.compactionPoint).not.toBeNull();
    expect(result.status).not.toBe('safe');

    // The task at compactionPoint index should have runningTotal <= 160k
    if (result.compactionPoint !== null) {
      const taskAtPoint = result.tasks[result.compactionPoint];
      expect(taskAtPoint.runningTotal).toBeLessThanOrEqual(160_000);
      // The next task should be above warning
      if (result.compactionPoint + 1 < result.tasks.length) {
        expect(result.tasks[result.compactionPoint + 1].runningTotal).toBeGreaterThan(160_000);
      }
    }
  });

  it('file count increases token estimate', async () => {
    const { estimateCognitiveLoad } = await import('./cognitive-load.js');

    const withoutFiles = estimateCognitiveLoad([{
      title: 'Task A',
      description: 'A standard implementation task',
      type: 'feature',
    }], 0);

    const withFiles = estimateCognitiveLoad([{
      title: 'Task B',
      description: 'A standard implementation task',
      type: 'feature',
      files: ['file1.ts', 'file2.ts', 'file3.ts'],
    }], 0);

    // 3 files * 1500 tokens/file = 4500 additional tokens
    expect(withFiles.tasks[0].estimatedTokens).toBeGreaterThan(
      withoutFiles.tasks[0].estimatedTokens
    );
    expect(withFiles.totalEstimatedTokens).toBeGreaterThan(
      withoutFiles.totalEstimatedTokens
    );
  });

  it('different task types have different base estimates', async () => {
    const { estimateCognitiveLoad } = await import('./cognitive-load.js');

    const types = ['feature', 'fix', 'refactor', 'test', 'docs', 'migration'];
    const estimates = types.map(type => {
      const result = estimateCognitiveLoad([{
        title: `${type} task`,
        description: 'A standard implementation task',
        type,
      }], 0);
      return { type, tokens: result.tasks[0].estimatedTokens };
    });

    // feature (8000) > refactor (6000) > test (5000) > fix (4000) > docs (3000) = migration (3000)
    const featureTokens = estimates.find(e => e.type === 'feature')!.tokens;
    const fixTokens = estimates.find(e => e.type === 'fix')!.tokens;
    const docsTokens = estimates.find(e => e.type === 'docs')!.tokens;

    expect(featureTokens).toBeGreaterThan(fixTokens);
    expect(fixTokens).toBeGreaterThan(docsTokens);
  });

  it('default context usage is 30% when not provided', async () => {
    const { estimateCognitiveLoad } = await import('./cognitive-load.js');

    const result = estimateCognitiveLoad([{
      title: 'Task',
      description: 'Description',
      type: 'fix',
    }]);

    // 30% of 200k = 60k
    expect(result.currentUsageTokens).toBe(60_000);
  });

  it('recommendation text matches status', async () => {
    const { estimateCognitiveLoad } = await import('./cognitive-load.js');

    // Safe case
    const safe = estimateCognitiveLoad([{
      title: 'Small fix',
      description: 'Tiny change',
      type: 'fix',
    }], 10);
    expect(safe.recommendation).toContain('No compaction needed');

    // Warning case: start at 75%, add enough tasks to cross 80%
    const warning = estimateCognitiveLoad([{
      title: 'Feature',
      description: 'A standard implementation task requiring some effort',
      type: 'feature',
      files: ['a.ts', 'b.ts'],
    }], 75);
    expect(warning.recommendation).toContain('compaction');

    // Critical case: start at 90%, add large tasks
    const critical = estimateCognitiveLoad([
      { title: 'Big task 1', description: 'A '.repeat(150) + 'complex', type: 'feature', files: ['a.ts', 'b.ts', 'c.ts'] },
      { title: 'Big task 2', description: 'A '.repeat(150) + 'complex', type: 'feature', files: ['d.ts', 'e.ts', 'f.ts'] },
    ], 90);
    expect(critical.recommendation).toContain('overflow');
  });

  it('estimateCognitiveLoad is exported and callable directly', async () => {
    const mod = await import('./cognitive-load.js');

    expect(typeof mod.estimateCognitiveLoad).toBe('function');

    const result = mod.estimateCognitiveLoad([], 50);
    expect(result.status).toBe('safe');
    expect(result.totalEstimatedTokens).toBe(0);
    expect(result.currentUsageTokens).toBe(100_000);
    expect(result.contextCapacity).toBe(200_000);
    expect(result.tasks).toEqual([]);
    expect(result.compactionPoint).toBeNull();
  });

  it('tool handler returns formatted report with table', async () => {
    const handler = await getHandler();
    const result = await handler({
      remaining_tasks: [
        { title: 'Task A', description: 'Build the widget', type: 'feature' },
        { title: 'Task B', description: 'Write tests', type: 'test' },
      ],
      context_usage_percent: 20,
    });
    const text = result.content[0].text;

    expect(text).toContain('# Cognitive Load Prediction');
    expect(text).toContain('Task A');
    expect(text).toContain('Task B');
    expect(text).toContain('**Recommendation:**');
    expect(text).toContain('| # | Task |');
  });

  it('description length affects token estimate', async () => {
    const { estimateCognitiveLoad } = await import('./cognitive-load.js');

    const shortDesc = estimateCognitiveLoad([{
      title: 'Short',
      description: 'Fix it',
      type: 'feature',
    }], 0);

    const longDesc = estimateCognitiveLoad([{
      title: 'Long',
      description: 'This is a very long and detailed description that explains exactly what needs to be done including all the edge cases and error handling and validation rules and database migrations and API changes and client components that need to be updated',
      type: 'feature',
    }], 0);

    // Short description (<=50 chars) gets 0.8x multiplier
    // Long description (>=200 chars) gets 1.3x multiplier
    expect(longDesc.tasks[0].estimatedTokens).toBeGreaterThan(
      shortDesc.tasks[0].estimatedTokens
    );
  });

  it('unknown task type uses default estimate', async () => {
    const { estimateCognitiveLoad } = await import('./cognitive-load.js');

    const unknownType = estimateCognitiveLoad([{
      title: 'Mystery task',
      description: 'A standard implementation task',
      type: 'unknown_type',
    }], 0);

    const noType = estimateCognitiveLoad([{
      title: 'No type task',
      description: 'A standard implementation task',
    }], 0);

    // Both should use default 5000 base, same multiplier for same description
    expect(unknownType.tasks[0].estimatedTokens).toBe(noType.tasks[0].estimatedTokens);
  });

  it('logs prediction start and completion', async () => {
    const handler = await getHandler();
    await handler({
      remaining_tasks: [
        { title: 'Task', description: 'Do something', type: 'fix' },
      ],
      context_usage_percent: 40,
    });

    const { logger } = await import('../../config/logger.js');
    expect(logger.info).toHaveBeenCalledWith('Cognitive load prediction started', {
      taskCount: 1,
      contextUsagePercent: 40,
    });
    expect(logger.info).toHaveBeenCalledWith('Cognitive load prediction complete', expect.objectContaining({
      status: expect.any(String),
      totalEstimatedTokens: expect.any(Number),
    }));
  });

  it('safe status has null compaction point', async () => {
    const { estimateCognitiveLoad } = await import('./cognitive-load.js');

    const result = estimateCognitiveLoad([{
      title: 'Simple fix',
      description: 'Small change',
      type: 'fix',
    }], 10);

    expect(result.status).toBe('safe');
    expect(result.compactionPoint).toBeNull();
  });

  it('overflow risk flag set correctly per task', async () => {
    const { estimateCognitiveLoad } = await import('./cognitive-load.js');

    // Start at 75%, so ~150k tokens used. Warning at 160k.
    // A feature task is ~8k tokens, so first task (~158k) should be OK,
    // second task (~166k) should have overflow risk.
    const result = estimateCognitiveLoad([
      { title: 'Task 1', description: 'A standard implementation task', type: 'feature' },
      { title: 'Task 2', description: 'A standard implementation task', type: 'feature' },
    ], 75);

    expect(result.tasks[0].overflowRisk).toBe(false);
    expect(result.tasks[1].overflowRisk).toBe(true);
  });
});
