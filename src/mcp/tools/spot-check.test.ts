import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDiff, parseSpotCheckResponse, formatSpotCheckOutput, runSpotCheck } from './spot-check.js';
import type { SpotCheckResult, SpotCheckFinding } from './spot-check.js';
import type Anthropic from '@anthropic-ai/sdk';

// Mock dependencies
vi.mock('../../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(),
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

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { getAnthropicClient } from '../../config/anthropic.js';

describe('getDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs git diff --staged for staged scope', () => {
    vi.mocked(execFileSync).mockReturnValue('diff content');
    const result = getDiff('staged', '/some/path');
    expect(result).toBe('diff content');
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['diff', '--staged', '--', '*.ts', '*.tsx', '*.js', '*.jsx'],
      expect.objectContaining({ cwd: '/some/path' }),
    );
  });

  it('runs git diff HEAD~1 HEAD for last-commit scope', () => {
    vi.mocked(execFileSync).mockReturnValue('diff content');
    getDiff('last-commit', '/some/path');
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['diff', 'HEAD~1', 'HEAD', '--', '*.ts', '*.tsx', '*.js', '*.jsx'],
      expect.objectContaining({ cwd: '/some/path' }),
    );
  });

  it('runs git diff branch...HEAD for branch scope', () => {
    vi.mocked(execFileSync).mockReturnValue('diff content');
    getDiff('main', '/some/path');
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['diff', 'main...HEAD', '--', '*.ts', '*.tsx', '*.js', '*.jsx'],
      expect.objectContaining({ cwd: '/some/path' }),
    );
  });

  it('returns empty string on error', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not a git repo'); });
    expect(getDiff('staged', '/nope')).toBe('');
  });
});

describe('parseSpotCheckResponse', () => {
  it('parses tool_use block with findings', () => {
    const response = {
      content: [{
        type: 'tool_use' as const,
        id: 'toolu_test',
        name: 'spot_check_findings',
        input: {
          findings: [
            { file: 'src/a.ts', line: 10, severity: 'high', category: 'hardcoded_secret', message: 'API key detected' },
            { file: 'src/b.ts', line: 20, severity: 'low', category: 'console_log', message: 'Debug log left in' },
          ],
          summary: 'Two issues found',
        },
      }],
    } as unknown as Anthropic.Message;

    const result = parseSpotCheckResponse(response);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].severity).toBe('high');
    expect(result.findings[0].category).toBe('hardcoded_secret');
    expect(result.findings[1].severity).toBe('low');
    expect(result.summary).toBe('Two issues found');
  });

  it('returns empty findings when no tool_use block', () => {
    const response = {
      content: [{ type: 'text' as const, text: 'No findings' }],
    } as unknown as Anthropic.Message;

    const result = parseSpotCheckResponse(response);
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain('Could not parse');
  });

  it('handles empty findings array', () => {
    const response = {
      content: [{
        type: 'tool_use' as const,
        id: 'toolu_test',
        name: 'spot_check_findings',
        input: { findings: [], summary: 'Clean diff' },
      }],
    } as unknown as Anthropic.Message;

    const result = parseSpotCheckResponse(response);
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toBe('Clean diff');
  });

  it('defaults severity to medium for unknown values', () => {
    const response = {
      content: [{
        type: 'tool_use' as const,
        id: 'toolu_test',
        name: 'spot_check_findings',
        input: {
          findings: [{ file: 'a.ts', line: 1, severity: 'critical', category: 'other', message: 'Bad' }],
          summary: 'Issue',
        },
      }],
    } as unknown as Anthropic.Message;

    const result = parseSpotCheckResponse(response);
    expect(result.findings[0].severity).toBe('medium');
  });
});

describe('formatSpotCheckOutput', () => {
  it('formats clean results', () => {
    const result: SpotCheckResult = {
      findings: [],
      summary: 'All clean',
      diffLines: 50,
      costUsd: 0.002,
    };

    const output = formatSpotCheckOutput(result);
    expect(output).toContain('No issues found');
    expect(output).toContain('50 diff lines');
    expect(output).toContain('$0.002');
  });

  it('formats findings with severity counts', () => {
    const findings: SpotCheckFinding[] = [
      { file: 'a.ts', line: 10, severity: 'high', category: 'hardcoded_secret', message: 'Key found' },
      { file: 'b.ts', line: 20, severity: 'medium', category: 'any_type', message: 'Uses any' },
      { file: 'c.ts', line: 30, severity: 'low', category: 'console_log', message: 'Debug log' },
    ];

    const result: SpotCheckResult = {
      findings,
      summary: 'Three issues',
      diffLines: 100,
      costUsd: 0.003,
    };

    const output = formatSpotCheckOutput(result);
    expect(output).toContain('3 findings');
    expect(output).toContain('1 high');
    expect(output).toContain('1 medium');
    expect(output).toContain('1 low');
    expect(output).toContain('[HIGH]');
    expect(output).toContain('[MED]');
    expect(output).toContain('[LOW]');
    expect(output).toContain('a.ts:10');
  });
});

describe('runSpotCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty result for empty diff', async () => {
    const result = await runSpotCheck('');
    expect(result.findings).toHaveLength(0);
    expect(result.diffLines).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it('calls Haiku API and parses response', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{
        type: 'tool_use',
        id: 'toolu_test',
        name: 'spot_check_findings',
        input: {
          findings: [{ file: 'x.ts', line: 5, severity: 'low', category: 'console_log', message: 'log' }],
          summary: 'Minor issue',
        },
      }],
      usage: { input_tokens: 200, output_tokens: 100 },
    });

    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: mockCreate },
    } as unknown as ReturnType<typeof getAnthropicClient>);

    const result = await runSpotCheck('+console.log("debug");\n');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].category).toBe('console_log');
    expect(result.costUsd).toBeGreaterThan(0);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
