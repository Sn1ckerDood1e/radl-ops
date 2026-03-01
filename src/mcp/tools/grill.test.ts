import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

vi.mock('../../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(),
}));

vi.mock('../../models/router.js', () => ({
  getRoute: vi.fn(() => ({ model: 'claude-sonnet-4-6', maxTokens: 4096 })),
  calculateCost: vi.fn(() => 0.015),
}));

vi.mock('../../models/token-tracker.js', () => ({
  trackUsage: vi.fn(),
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/retry.js', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    radlDir: '/tmp/test-radl',
    radlOpsDir: '/tmp/test-ops',
  })),
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

vi.mock('./spot-check.js', () => ({
  getDiff: vi.fn(),
}));

import { getAnthropicClient } from '../../config/anthropic.js';
import { parseGrillResponse, formatGrillOutput, runGrill } from './grill.js';
import type { GrillResult } from './grill.js';

describe('parseGrillResponse', () => {
  it('parses SHIP_IT verdict with no findings', () => {
    const response = {
      content: [{
        type: 'tool_use' as const,
        id: 'toolu_test',
        name: 'grill_verdict',
        input: {
          verdict: 'SHIP_IT',
          findings: [],
          summary: 'Clean diff, no issues',
        },
      }],
    } as unknown as Anthropic.Message;

    const result = parseGrillResponse(response);
    expect(result.verdict).toBe('SHIP_IT');
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toBe('Clean diff, no issues');
  });

  it('parses BLOCK verdict with findings', () => {
    const response = {
      content: [{
        type: 'tool_use' as const,
        id: 'toolu_test',
        name: 'grill_verdict',
        input: {
          verdict: 'BLOCK',
          findings: [{
            file: 'src/api/auth.ts',
            line: 42,
            severity: 'critical',
            category: 'security',
            message: 'Missing auth check',
            remediation: 'Add getUser() verification before database access',
          }],
          summary: 'Critical security issue found',
        },
      }],
    } as unknown as Anthropic.Message;

    const result = parseGrillResponse(response);
    expect(result.verdict).toBe('BLOCK');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
    expect(result.findings[0].remediation).toContain('getUser');
  });

  it('returns NEEDS_WORK when no tool_use block present', () => {
    const response = {
      content: [{ type: 'text' as const, text: 'Some text response' }],
    } as unknown as Anthropic.Message;

    const result = parseGrillResponse(response);
    expect(result.verdict).toBe('NEEDS_WORK');
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain('Could not parse');
  });

  it('defaults invalid verdict to NEEDS_WORK', () => {
    const response = {
      content: [{
        type: 'tool_use' as const,
        id: 'toolu_test',
        name: 'grill_verdict',
        input: {
          verdict: 'INVALID_VERDICT',
          findings: [],
          summary: 'Test',
        },
      }],
    } as unknown as Anthropic.Message;

    const result = parseGrillResponse(response);
    expect(result.verdict).toBe('NEEDS_WORK');
  });

  it('defaults invalid severity to medium', () => {
    const response = {
      content: [{
        type: 'tool_use' as const,
        id: 'toolu_test',
        name: 'grill_verdict',
        input: {
          verdict: 'NEEDS_WORK',
          findings: [{
            file: 'a.ts',
            line: 1,
            severity: 'catastrophic',
            category: 'other',
            message: 'Bad',
            remediation: 'Fix it',
          }],
          summary: 'Issue found',
        },
      }],
    } as unknown as Anthropic.Message;

    const result = parseGrillResponse(response);
    expect(result.findings[0].severity).toBe('medium');
  });
});

describe('formatGrillOutput', () => {
  it('formats clean SHIP_IT result', () => {
    const result: GrillResult = {
      verdict: 'SHIP_IT',
      findings: [],
      summary: 'All clean',
      diffLines: 50,
      costUsd: 0.012,
    };

    const output = formatGrillOutput(result);
    expect(output).toContain('SHIP IT');
    expect(output).toContain('No issues found');
    expect(output).toContain('50 diff lines');
    expect(output).toContain('$0.012');
  });

  it('formats BLOCK result with findings and remediation', () => {
    const result: GrillResult = {
      verdict: 'BLOCK',
      findings: [
        { file: 'src/a.ts', line: 10, severity: 'critical', category: 'security', message: 'SQL injection', remediation: 'Use parameterized queries' },
        { file: 'src/b.ts', line: 20, severity: 'high', category: 'correctness', message: 'Off-by-one', remediation: 'Use < instead of <=' },
        { file: 'src/c.ts', line: 30, severity: 'medium', category: 'maintainability', message: 'Dead code', remediation: 'Remove unused function' },
        { file: 'src/d.ts', line: 40, severity: 'low', category: 'performance', message: 'Unnecessary re-render', remediation: 'Wrap with useMemo' },
      ],
      summary: 'Critical issues found',
      diffLines: 200,
      costUsd: 0.025,
    };

    const output = formatGrillOutput(result);
    expect(output).toContain('BLOCK');
    expect(output).toContain('4 findings');
    expect(output).toContain('1 critical');
    expect(output).toContain('1 high');
    expect(output).toContain('[CRIT]');
    expect(output).toContain('[HIGH]');
    expect(output).toContain('[MED]');
    expect(output).toContain('[LOW]');
    expect(output).toContain('Fix: Use parameterized queries');
    expect(output).toContain('src/a.ts:10');
  });
});

describe('runGrill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns SHIP_IT for empty diff', async () => {
    const result = await runGrill('');
    expect(result.verdict).toBe('SHIP_IT');
    expect(result.findings).toHaveLength(0);
    expect(result.diffLines).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it('calls Sonnet API and parses response', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{
        type: 'tool_use',
        id: 'toolu_test',
        name: 'grill_verdict',
        input: {
          verdict: 'NEEDS_WORK',
          findings: [{
            file: 'x.ts',
            line: 5,
            severity: 'medium',
            category: 'maintainability',
            message: 'Complex function',
            remediation: 'Extract helper',
          }],
          summary: 'Minor issues',
        },
      }],
      usage: { input_tokens: 500, output_tokens: 200 },
    });

    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: mockCreate },
    } as unknown as ReturnType<typeof getAnthropicClient>);

    const result = await runGrill('+function complex() { /* lots of code */ }\n');
    expect(result.verdict).toBe('NEEDS_WORK');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].remediation).toBe('Extract helper');
    expect(result.costUsd).toBeGreaterThan(0);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('truncates diff at 50K chars', async () => {
    const longDiff = 'x'.repeat(60000);
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{
        type: 'tool_use',
        id: 'toolu_test',
        name: 'grill_verdict',
        input: { verdict: 'SHIP_IT', findings: [], summary: 'OK' },
      }],
      usage: { input_tokens: 1000, output_tokens: 50 },
    });

    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: mockCreate },
    } as unknown as ReturnType<typeof getAnthropicClient>);

    await runGrill(longDiff);

    const callArgs = mockCreate.mock.calls[0][0];
    const content = callArgs.messages[0].content as string;
    // 50K limit + truncation notice + prefix text
    expect(content.length).toBeLessThan(60000);
    expect(content).toContain('[DIFF TRUNCATED]');
  });
});
