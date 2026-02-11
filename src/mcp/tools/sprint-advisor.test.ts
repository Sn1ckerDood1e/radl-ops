import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
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

vi.mock('../../models/router.js', () => ({
  getRoute: vi.fn(() => ({
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    maxTokens: 4096,
    inputCostPer1M: 1,
    outputCostPer1M: 5,
  })),
  calculateCost: vi.fn(() => 0.001),
}));

vi.mock('../../models/token-tracker.js', () => ({
  trackUsage: vi.fn(),
}));

// Mock Anthropic client
const mockCreate = vi.fn();
vi.mock('../../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(() => ({
    messages: { create: mockCreate },
  })),
}));

async function getHandler() {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: Function) => {
      handlers[_name] = handler;
    },
  };

  const { registerSprintAdvisorTools } = await import('./sprint-advisor.js');
  registerSprintAdvisorTools(mockServer as any);
  return handlers['sprint_advisor'];
}

function mockToolUseResponse(input: Record<string, unknown>) {
  return {
    content: [{
      type: 'tool_use',
      id: 'test',
      name: 'team_advice',
      input,
    }],
    usage: { input_tokens: 100, output_tokens: 200 },
  };
}

describe('Sprint Advisor Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it('returns team recommendation for independent tasks', async () => {
    mockCreate.mockResolvedValueOnce(mockToolUseResponse({
      useTeam: true,
      recipe: 'review',
      rationale: '4 independent review tasks can run in parallel',
      suggestedSplit: [
        { teammate: 'security-reviewer', tasks: ['Security audit'] },
        { teammate: 'code-reviewer', tasks: ['Code quality'] },
      ],
      estimatedTimeSaved: '15 minutes',
      risks: ['Some file overlap in auth module'],
    }));

    const handler = await getHandler();
    const result = await handler({
      tasks: [
        { description: 'Security audit of auth' },
        { description: 'Code quality review' },
        { description: 'Architecture review' },
        { description: 'Test coverage analysis' },
      ],
    });
    const text = result.content[0].text;

    expect(text).toContain('Use agent team (review recipe)');
    expect(text).toContain('Suggested Task Split');
    expect(text).toContain('15 minutes');
    expect(text).toContain('team_recipe');
    expect(text).toContain('Cost:');
  });

  it('returns no-team recommendation for few tasks', async () => {
    mockCreate.mockResolvedValueOnce(mockToolUseResponse({
      useTeam: false,
      recipe: 'none',
      rationale: 'Only 2 tasks, sequential is fine',
      suggestedSplit: [],
      estimatedTimeSaved: '0',
      risks: [],
    }));

    const handler = await getHandler();
    const result = await handler({
      tasks: [
        { description: 'Fix login bug' },
        { description: 'Update tests' },
      ],
    });
    const text = result.content[0].text;

    expect(text).toContain('No team needed');
    expect(text).not.toContain('Suggested Task Split');
  });

  it('uses Haiku model via spot_check route', async () => {
    mockCreate.mockResolvedValueOnce(mockToolUseResponse({
      useTeam: false,
      recipe: 'none',
      rationale: 'Test',
      suggestedSplit: [],
      estimatedTimeSaved: '0',
      risks: [],
    }));

    const handler = await getHandler();
    await handler({ tasks: [{ description: 'Test task' }] });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        tool_choice: { type: 'tool', name: 'team_advice' },
      })
    );
  });

  it('validates tool_use response with Zod', async () => {
    // Invalid response (missing required fields)
    mockCreate.mockResolvedValueOnce({
      content: [{
        type: 'tool_use',
        id: 'test',
        name: 'team_advice',
        input: { useTeam: 'not a boolean' }, // Invalid
      }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });

    const handler = await getHandler();
    const result = await handler({ tasks: [{ description: 'Test' }] });
    const text = result.content[0].text;

    // Should fall back to text parsing
    expect(text).toContain('No team needed');
    expect(text).toContain('manual decision');
  });

  it('falls back gracefully when no tool_use block', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I recommend using a team' }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });

    const handler = await getHandler();
    const result = await handler({ tasks: [{ description: 'Test' }] });
    const text = result.content[0].text;

    expect(text).toContain('No team needed');
    expect(text).toContain('manual decision');
  });

  it('includes historical team runs in prompt when available', async () => {
    const existingStore = {
      runs: [
        { id: 1, sprintPhase: 'Phase 60', recipe: 'review', teammateCount: 3, model: 'sonnet', duration: '5 min', outcome: 'success', date: '2026-02-10' },
      ],
    };
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(existingStore));

    mockCreate.mockResolvedValueOnce(mockToolUseResponse({
      useTeam: true,
      recipe: 'review',
      rationale: 'Similar to past successful review',
      suggestedSplit: [{ teammate: 'reviewer', tasks: ['Review'] }],
      estimatedTimeSaved: '10 min',
      risks: [],
    }));

    const handler = await getHandler();
    await handler({
      tasks: [{ description: 'Review code' }, { description: 'Review tests' }, { description: 'Review docs' }],
    });

    // Check that the user message includes history
    const callArgs = mockCreate.mock.calls[0][0];
    const userContent = callArgs.messages[0].content;
    expect(userContent).toContain('Recent successful team runs');
    expect(userContent).toContain('review recipe');
  });

  it('includes sprint_context in user message', async () => {
    mockCreate.mockResolvedValueOnce(mockToolUseResponse({
      useTeam: false,
      recipe: 'none',
      rationale: 'Test',
      suggestedSplit: [],
      estimatedTimeSaved: '0',
      risks: [],
    }));

    const handler = await getHandler();
    await handler({
      tasks: [{ description: 'Test task' }],
      sprint_context: 'Phase 62 — Security audit',
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const userContent = callArgs.messages[0].content;
    expect(userContent).toContain('Phase 62');
  });

  it('includes task files and types in prompt', async () => {
    mockCreate.mockResolvedValueOnce(mockToolUseResponse({
      useTeam: false,
      recipe: 'none',
      rationale: 'Test',
      suggestedSplit: [],
      estimatedTimeSaved: '0',
      risks: [],
    }));

    const handler = await getHandler();
    await handler({
      tasks: [{ description: 'Review auth', files: ['src/lib/auth.ts'], type: 'review' }],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const userContent = callArgs.messages[0].content;
    expect(userContent).toContain('src/lib/auth.ts');
    expect(userContent).toContain('(review)');
  });
});
