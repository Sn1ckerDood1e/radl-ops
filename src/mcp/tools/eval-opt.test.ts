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

const mockRunEvalOptLoop = vi.fn();
vi.mock('../../patterns/evaluator-optimizer.js', () => ({
  runEvalOptLoop: (...args: unknown[]) => mockRunEvalOptLoop(...args),
}));

// Extract handler by registering with a mock server
async function getHandler() {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
  };

  const { registerEvalOptTools } = await import('./eval-opt.js');
  registerEvalOptTools(mockServer as any);
  return handlers['eval_opt_generate'];
}

function makeEvalOptResult(overrides: Record<string, unknown> = {}) {
  return {
    finalOutput: 'Generated content here',
    finalScore: 8,
    iterations: 2,
    totalCostUsd: 0.003,
    evaluations: [],
    converged: true,
    terminationReason: 'threshold_met',
    attempts: [],
    cacheSavingsUsd: 0,
    errors: [],
    ...overrides,
  };
}

describe('Eval-Opt Generate Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunEvalOptLoop.mockResolvedValue(makeEvalOptResult());
  });

  it('returns generated content with quality metadata', async () => {
    const handler = await getHandler();
    const result = await handler({
      prompt: 'Write a product description for rowing software',
      criteria: ['Clarity', 'Persuasiveness'],
    });
    const text = result.content[0].text;

    expect(text).toContain('Generated content here');
    expect(text).toContain('Quality: 8/10');
    expect(text).toContain('Iterations: 2');
    expect(text).toContain('Converged: true');
    expect(text).toContain('Cost: $0.003');
  });

  it('uses haiku (generator) and sonnet (evaluator) by default', async () => {
    const handler = await getHandler();
    await handler({
      prompt: 'Write a product description for rowing software',
      criteria: ['Clarity'],
    });

    expect(mockRunEvalOptLoop).toHaveBeenCalledWith(
      'Write a product description for rowing software',
      expect.objectContaining({
        generatorTaskType: 'spot_check',    // haiku
        evaluatorTaskType: 'conversation', // sonnet
      })
    );
  });

  it('maps custom model overrides to correct task types', async () => {
    const handler = await getHandler();
    await handler({
      prompt: 'Write a product description for rowing software',
      criteria: ['Clarity'],
      generator_model: 'sonnet',
      evaluator_model: 'opus',
    });

    expect(mockRunEvalOptLoop).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        generatorTaskType: 'conversation',  // sonnet
        evaluatorTaskType: 'architecture',  // opus
      })
    );
  });

  it('passes quality threshold to config', async () => {
    const handler = await getHandler();
    await handler({
      prompt: 'Write a product description for rowing software',
      criteria: ['Clarity'],
      quality_threshold: 9,
    });

    expect(mockRunEvalOptLoop).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        qualityThreshold: 9,
      })
    );
  });

  it('passes max iterations to config', async () => {
    const handler = await getHandler();
    await handler({
      prompt: 'Write a product description for rowing software',
      criteria: ['Clarity'],
      max_iterations: 5,
    });

    expect(mockRunEvalOptLoop).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        maxIterations: 5,
      })
    );
  });

  it('includes error messages in output when present', async () => {
    mockRunEvalOptLoop.mockResolvedValue(makeEvalOptResult({
      errors: ['Generator failed (iteration 2): API timeout'],
      converged: false,
      finalScore: 5,
    }));

    const handler = await getHandler();
    const result = await handler({
      prompt: 'Write a product description for rowing software',
      criteria: ['Clarity'],
    });
    const text = result.content[0].text;

    expect(text).toContain('Generator failed (iteration 2): API timeout');
    expect(text).toContain('Converged: false');
  });

  it('passes evaluation criteria through to config', async () => {
    const handler = await getHandler();
    await handler({
      prompt: 'Write a product description for rowing software',
      criteria: ['Clarity', 'Persuasiveness', 'Technical accuracy'],
    });

    expect(mockRunEvalOptLoop).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        evaluationCriteria: ['Clarity', 'Persuasiveness', 'Technical accuracy'],
      })
    );
  });

  it('uses default threshold of 7 when not specified', async () => {
    const handler = await getHandler();
    await handler({
      prompt: 'Write a product description for rowing software',
      criteria: ['Clarity'],
    });

    expect(mockRunEvalOptLoop).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        qualityThreshold: 7,
      })
    );
  });

  it('uses default max iterations of 3 when not specified', async () => {
    const handler = await getHandler();
    await handler({
      prompt: 'Write a product description for rowing software',
      criteria: ['Clarity'],
    });

    expect(mockRunEvalOptLoop).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        maxIterations: 3,
      })
    );
  });
});
