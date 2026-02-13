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

  const { registerReviewPipelineTools } = await import('./review-pipeline.js');
  registerReviewPipelineTools(mockServer as any);
  return handlers['review_pipeline'];
}

describe('Review Pipeline Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns recipe with 3 reviewers', async () => {
    const handler = await getHandler();
    const result = await handler({});
    const text = result.content[0].text;

    expect(text).toContain('security-reviewer');
    expect(text).toContain('code-reviewer');
    expect(text).toContain('architect');
  });

  it('includes audit triage template section', async () => {
    const handler = await getHandler();
    const result = await handler({});
    const text = result.content[0].text;

    expect(text).toContain('Audit Triage Template');
    expect(text).toContain('audit_triage');
    expect(text).toContain('DO_NOW');
    expect(text).toContain('DO_SOON');
    expect(text).toContain('DEFER');
  });

  it('includes orchestration checklist', async () => {
    const handler = await getHandler();
    const result = await handler({});
    const text = result.content[0].text;

    expect(text).toContain('Orchestration Checklist');
    expect(text).toContain('TeamCreate');
    expect(text).toContain('TaskCreate');
    expect(text).toContain('shutdown_request');
    expect(text).toContain('TeamDelete');
    expect(text).toContain('team_used');
    expect(text).toContain('sprint_complete');
  });

  it('defaults to sonnet model', async () => {
    const handler = await getHandler();
    const result = await handler({});
    const text = result.content[0].text;

    // Parse the JSON recipe to check model
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).toBeTruthy();
    const recipe = JSON.parse(jsonMatch![1]);
    for (const t of recipe.teammates) {
      expect(t.model).toBe('sonnet');
    }
  });

  it('interpolates context into recipe and triage template', async () => {
    const handler = await getHandler();
    const result = await handler({ context: 'Phase 62 auth security review' });
    const text = result.content[0].text;

    // Context appears in recipe task descriptions
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
    const recipe = JSON.parse(jsonMatch![1]);
    for (const t of recipe.teammates) {
      expect(t.taskDescription).toContain('Phase 62 auth security review');
    }

    // Context appears in triage template
    expect(text).toContain('Phase 62 auth security review');
  });

  it('includes files in recipe when provided', async () => {
    const handler = await getHandler();
    const result = await handler({ files: 'src/lib/auth, src/app/api/auth' });
    const text = result.content[0].text;

    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
    const recipe = JSON.parse(jsonMatch![1]);
    for (const t of recipe.teammates) {
      expect(t.taskDescription).toContain('src/lib/auth, src/app/api/auth');
    }
  });
});
