import { describe, it, expect } from 'vitest';
import { validateAgentTaskSize, formatAgentDispatchSection } from './agent-validation.js';
import type { DecomposedTask } from './decomposition.js';

function makeTask(overrides: Partial<DecomposedTask> = {}): DecomposedTask {
  return {
    id: 1,
    title: 'Test task',
    description: 'A test task',
    activeForm: 'Testing',
    type: 'feature',
    files: ['src/a.ts', 'src/b.ts'],
    dependsOn: [],
    estimateMinutes: 30,
    ...overrides,
  };
}

describe('validateAgentTaskSize', () => {
  it('returns valid for small tasks', () => {
    const result = validateAgentTaskSize(makeTask({ files: ['a.ts', 'b.ts'] }));
    expect(result.isValid).toBe(true);
    expect(result.recommendation).toBe('dispatch');
    expect(result.fileCount).toBe(2);
    expect(result.estimatedTokens).toBe(10_000);
  });

  it('returns invalid for tasks with too many files', () => {
    const result = validateAgentTaskSize(makeTask({
      files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
    }));
    expect(result.isValid).toBe(false);
    expect(result.recommendation).toBe('split');
    expect(result.reason).toContain('6 files');
  });

  it('returns leader-only for tasks with no files', () => {
    const result = validateAgentTaskSize(makeTask({ files: [] }));
    expect(result.isValid).toBe(false);
    expect(result.recommendation).toBe('leader-only');
  });

  it('returns valid at exact file limit', () => {
    const result = validateAgentTaskSize(makeTask({
      files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
    }));
    expect(result.isValid).toBe(true);
    expect(result.recommendation).toBe('dispatch');
  });
});

describe('formatAgentDispatchSection', () => {
  it('formats multiple tasks with recommendations', () => {
    const tasks = [
      makeTask({ id: 1, files: ['a.ts'] }),
      makeTask({ id: 2, files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'] }),
    ];

    const output = formatAgentDispatchSection(tasks);
    expect(output).toContain('#1');
    expect(output).toContain('OK');
    expect(output).toContain('#2');
    expect(output).toContain('WARN');
    expect(output).toContain('SPLIT');
  });
});
