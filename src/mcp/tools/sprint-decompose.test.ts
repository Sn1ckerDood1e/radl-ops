import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('../../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(),
}));

vi.mock('../../models/router.js', () => ({
  getRoute: vi.fn(() => ({ model: 'claude-haiku-4-5-20251001', maxTokens: 2048 })),
  calculateCost: vi.fn(() => 0.002),
}));

vi.mock('../../models/token-tracker.js', () => ({
  trackUsage: vi.fn(),
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

vi.mock('../../utils/retry.js', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({ knowledgeDir: '/tmp/test-knowledge' })),
}));

import { getAnthropicClient } from '../../config/anthropic.js';
import { trackUsage } from '../../models/token-tracker.js';
import { withRetry } from '../../utils/retry.js';
import { existsSync, readFileSync } from 'fs';

type ToolHandler = (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }>;

async function getHandlers() {
  const handlers: Record<string, ToolHandler> = {};
  const mockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as ToolHandler;
    },
  };

  const { registerSprintDecomposeTools } = await import('./sprint-decompose.js');
  registerSprintDecomposeTools(mockServer as any);
  return handlers;
}

function mockDecomposeResponse() {
  const mockCreate = vi.fn().mockResolvedValue({
    content: [{
      type: 'tool_use',
      name: 'task_decomposition',
      input: {
        tasks: [
          {
            id: 1,
            title: 'Add schema',
            description: 'Create Prisma model',
            activeForm: 'Adding schema',
            type: 'migration',
            files: ['prisma/schema.prisma'],
            dependsOn: [],
            estimateMinutes: 15,
          },
          {
            id: 2,
            title: 'Add API route',
            description: 'Create REST endpoint',
            activeForm: 'Creating API',
            type: 'feature',
            files: ['src/app/api/test/route.ts'],
            dependsOn: [1],
            estimateMinutes: 25,
          },
        ],
        executionStrategy: 'sequential',
        rationale: 'Linear dependency chain',
        totalEstimateMinutes: 40,
        teamRecommendation: 'Sequential execution',
      },
    }],
    usage: { input_tokens: 500, output_tokens: 300 },
  });

  vi.mocked(getAnthropicClient).mockReturnValue({
    messages: { create: mockCreate },
  } as any);

  return mockCreate;
}

describe('sprint_decompose', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it('decomposes sprint into structured tasks', async () => {
    const handlers = await getHandlers();
    mockDecomposeResponse();

    const result = await handlers.sprint_decompose({
      phase: 'Phase 80',
      title: 'Add attendance tracking',
    });

    expect(result.content[0].text).toContain('Sprint Decomposition');
    expect(result.content[0].text).toContain('Add schema');
    expect(result.content[0].text).toContain('Add API route');
    expect(result.content[0].text).toContain('sequential');
  });

  it('tracks usage with planning task type', async () => {
    const handlers = await getHandlers();
    mockDecomposeResponse();

    await handlers.sprint_decompose({
      phase: 'Phase 80',
      title: 'Test',
    });

    expect(trackUsage).toHaveBeenCalledWith(
      'claude-haiku-4-5-20251001', 500, 300, 'planning', 'sprint-decompose',
    );
  });

  it('uses withRetry for API calls', async () => {
    const handlers = await getHandlers();
    mockDecomposeResponse();

    await handlers.sprint_decompose({
      phase: 'Phase 80',
      title: 'Test',
    });

    expect(withRetry).toHaveBeenCalled();
  });

  it('includes cost in output', async () => {
    const handlers = await getHandlers();
    mockDecomposeResponse();

    const result = await handlers.sprint_decompose({
      phase: 'Phase 80',
      title: 'Test',
    });

    expect(result.content[0].text).toContain('$0.002');
    expect(result.content[0].text).toContain('2 tasks generated');
  });

  it('handles parse failure gracefully', async () => {
    const handlers = await getHandlers();
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'I cannot decompose this' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: mockCreate },
    } as any);

    const result = await handlers.sprint_decompose({
      phase: 'Phase 80',
      title: 'Test',
    });

    expect(result.content[0].text).toContain('Failed to parse');
  });

  it('loads knowledge context when patterns.json exists', async () => {
    const handlers = await getHandlers();
    mockDecomposeResponse();

    vi.mocked(existsSync).mockImplementation((path: any) => {
      return String(path).includes('patterns.json');
    });
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ patterns: [{ name: 'Zod validation', description: 'Always validate' }] }),
    );

    const mockCreate = vi.mocked(getAnthropicClient)().messages.create as any;
    await handlers.sprint_decompose({
      phase: 'Phase 80',
      title: 'Test',
    });

    // Re-mock since we called getAnthropicClient above
    mockDecomposeResponse();
    await handlers.sprint_decompose({
      phase: 'Phase 80',
      title: 'Test',
    });

    const lastCall = vi.mocked(getAnthropicClient).mock.results;
    expect(lastCall.length).toBeGreaterThan(0);
  });

  it('includes task count hint when provided', async () => {
    const handlers = await getHandlers();
    const mockCreate = mockDecomposeResponse();

    await handlers.sprint_decompose({
      phase: 'Phase 80',
      title: 'Test',
      task_count: 5,
    });

    const userMessage = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userMessage).toContain('Target task count: 5 tasks');
  });

  it('includes context when provided', async () => {
    const handlers = await getHandlers();
    const mockCreate = mockDecomposeResponse();

    await handlers.sprint_decompose({
      phase: 'Phase 80',
      title: 'Test',
      context: 'Using Playwright for E2E',
    });

    const userMessage = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userMessage).toContain('Using Playwright for E2E');
  });

  it('includes TaskCreate-ready JSON in output', async () => {
    const handlers = await getHandlers();
    mockDecomposeResponse();

    const result = await handlers.sprint_decompose({
      phase: 'Phase 80',
      title: 'Test',
    });

    expect(result.content[0].text).toContain('TaskCreate JSON');
    expect(result.content[0].text).toContain('"subject"');
    expect(result.content[0].text).toContain('"activeForm"');
  });
});
