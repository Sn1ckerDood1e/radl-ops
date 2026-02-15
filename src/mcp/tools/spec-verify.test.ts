import { describe, it, expect, vi } from 'vitest';
import { runSpecVerify, formatSpecVerifyOutput, extractCriteriaWithAI } from './spec-verify.js';

vi.mock('../../models/router.js', () => ({
  getRoute: () => ({ model: 'claude-haiku-4-5-20251001', maxTokens: 1024 }),
  calculateCost: () => 0.002,
}));

vi.mock('../../models/token-tracker.js', () => ({
  trackUsage: vi.fn(),
}));

vi.mock('../../config/anthropic.js', () => ({
  getAnthropicClient: () => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{
          type: 'tool_use',
          id: 'test',
          name: 'acceptance_criteria',
          input: {
            criteria: [
              { text: 'should display athlete list', type: 'functional' },
              { text: 'should validate email format', type: 'validation' },
            ],
          },
        }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    },
  }),
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../utils/retry.js', () => ({
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

describe('runSpecVerify', () => {
  it('extracts criteria with regex when ai_enhance is false', async () => {
    const spec = `
## Requirements
- Should display athlete name and number
- Must validate email format before saving
- Can navigate to profile page from roster
    `;

    const result = await runSpecVerify(spec, 'Athlete Management', false);
    expect(result.criteria.length).toBeGreaterThan(0);
    expect(result.skeleton.filePath).toBe('e2e/athlete-management.spec.ts');
    expect(result.skeleton.content).toContain('import { test, expect }');
    expect(result.costUsd).toBe(0);
  });

  it('extracts criteria with AI when ai_enhance is true', async () => {
    const spec = 'Build an athlete management feature';

    const result = await runSpecVerify(spec, 'Athlete Management', true);
    expect(result.criteria.length).toBe(2);
    expect(result.criteria[0].source).toBe('ai');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('generates test skeleton with correct file path', async () => {
    const spec = '- Should display dashboard widgets';
    const result = await runSpecVerify(spec, 'Team Dashboard', false);
    expect(result.skeleton.filePath).toBe('e2e/team-dashboard.spec.ts');
  });
});

describe('extractCriteriaWithAI', () => {
  it('parses AI response into criteria', async () => {
    const result = await extractCriteriaWithAI('Build a feature');
    expect(result.criteria.length).toBe(2);
    expect(result.criteria[0].text).toBe('should display athlete list');
    expect(result.criteria[0].type).toBe('functional');
    expect(result.criteria[0].source).toBe('ai');
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

describe('formatSpecVerifyOutput', () => {
  it('formats output with criteria and skeleton', () => {
    const result = {
      criteria: [{ id: 1, text: 'display athletes', type: 'functional' as const, source: 'regex' as const }],
      criteriaText: '## Acceptance Criteria (1)\n\n### Functional (1)\n1. display athletes',
      skeleton: {
        filePath: 'e2e/athletes.spec.ts',
        content: "import { test } from '@playwright/test';",
        criteriaCount: 1,
      },
      costUsd: 0,
    };

    const output = formatSpecVerifyOutput(result, 'Athlete Feature');
    expect(output).toContain('Spec-to-Verification: Athlete Feature');
    expect(output).toContain('Acceptance Criteria (1)');
    expect(output).toContain('e2e/athletes.spec.ts');
    expect(output).toContain('Sprint is not complete until all generated tests pass');
  });

  it('includes cost when AI was used', () => {
    const result = {
      criteria: [],
      criteriaText: 'No criteria',
      skeleton: { filePath: 'e2e/test.spec.ts', content: '', criteriaCount: 0 },
      costUsd: 0.002,
    };

    const output = formatSpecVerifyOutput(result, 'Test');
    expect(output).toContain('Cost: $0.002');
  });
});
