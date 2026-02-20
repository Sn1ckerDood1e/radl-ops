import { describe, it, expect } from 'vitest';
import {
  validateAgentTaskSize,
  formatAgentDispatchSection,
  formatWaveDispatchBlock,
  formatDispatchSummary,
} from './agent-validation.js';
import type { DecomposedTask } from './decomposition.js';
import type { ParallelWave } from './agent-validation.js';

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

function makeWave(overrides: Partial<ParallelWave> = {}): ParallelWave {
  return {
    waveNumber: 1,
    tasks: [],
    fileConflicts: [],
    hasConflicts: false,
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

describe('formatWaveDispatchBlock', () => {
  it('generates PARALLEL DISPATCH block for 3-task wave without conflicts', () => {
    const wave = makeWave({
      waveNumber: 2,
      tasks: [
        makeTask({ id: 1, title: 'Create API route', description: 'Build the endpoint', files: ['src/api/route.ts'] }),
        makeTask({ id: 2, title: 'Add validation schema', description: 'Zod schema', files: ['src/lib/validations.ts'] }),
        makeTask({ id: 3, title: 'Build UI component', description: 'React component', files: ['src/components/form.tsx'] }),
      ],
    });

    const output = formatWaveDispatchBlock(wave, 'attendance tracking');

    expect(output).toContain('Wave 2 (3 tasks — PARALLEL DISPATCH)');
    expect(output).toContain('#1 Create API route');
    expect(output).toContain('#2 Add validation schema');
    expect(output).toContain('#3 Build UI component');
    expect(output).toContain('No file conflicts.');
    expect(output).toContain('Agent Spawn Commands:');
    expect(output).toContain('subagent_type="general-purpose"');
    expect(output).toContain('run_in_background=true');
    expect(output).toContain('model="sonnet"');
    expect(output).toContain('After all agents complete:');
    expect(output).toContain('npm run typecheck');
  });

  it('generates SEQUENTIAL block for single-task wave', () => {
    const wave = makeWave({
      waveNumber: 1,
      tasks: [
        makeTask({ id: 1, title: 'Add schema migration', files: ['prisma/schema.prisma'] }),
      ],
    });

    const output = formatWaveDispatchBlock(wave, 'attendance tracking');

    expect(output).toContain('Wave 1 (1 task — SEQUENTIAL)');
    expect(output).toContain('#1 Add schema migration');
    expect(output).toContain('Execute directly');
    expect(output).not.toContain('Agent Spawn Commands');
  });

  it('generates SEQUENTIAL WITH WARNING block for waves with file conflicts', () => {
    const wave = makeWave({
      waveNumber: 3,
      tasks: [
        makeTask({ id: 4, title: 'Update page layout', files: ['src/page.tsx', 'src/layout.tsx'] }),
        makeTask({ id: 5, title: 'Add sidebar', files: ['src/page.tsx', 'src/sidebar.tsx'] }),
      ],
      fileConflicts: ['src/page.tsx (tasks: 4, 5)'],
      hasConflicts: true,
    });

    const output = formatWaveDispatchBlock(wave, 'dashboard update');

    expect(output).toContain('Wave 3 (2 tasks — SEQUENTIAL: file conflicts)');
    expect(output).toContain('#4 Update page layout');
    expect(output).toContain('#5 Add sidebar');
    expect(output).toContain('FILE CONFLICTS');
    expect(output).toContain('src/page.tsx');
    expect(output).toContain('execute these tasks sequentially');
    expect(output).not.toContain('Agent Spawn Commands');
  });

  it('generates REVIEW CHECKPOINT block', () => {
    const wave = makeWave({
      waveNumber: 4,
      isReviewCheckpoint: true,
    });

    const output = formatWaveDispatchBlock(wave, 'attendance tracking');

    expect(output).toContain('Wave 4 — REVIEW CHECKPOINT');
    expect(output).toContain('code-reviewer');
    expect(output).toContain('security-reviewer');
    expect(output).toContain('Fix CRITICAL/HIGH');
  });

  it('includes file ownership in agent prompts', () => {
    const wave = makeWave({
      waveNumber: 1,
      tasks: [
        makeTask({ id: 1, title: 'Task A', description: 'Do A', files: ['src/a.ts', 'src/b.ts'] }),
        makeTask({ id: 2, title: 'Task B', description: 'Do B', files: ['src/c.ts'] }),
      ],
    });

    const output = formatWaveDispatchBlock(wave, 'feature X');

    expect(output).toContain('Files you own (ONLY modify these): src/a.ts, src/b.ts');
    expect(output).toContain('Files you own (ONLY modify these): src/c.ts');
  });

  it('includes task description in agent prompts', () => {
    const wave = makeWave({
      waveNumber: 1,
      tasks: [
        makeTask({ id: 1, title: 'Create endpoint', description: 'Build POST /api/attendance' }),
        makeTask({ id: 2, title: 'Add UI', description: 'React check-in form' }),
      ],
    });

    const output = formatWaveDispatchBlock(wave, 'attendance');

    expect(output).toContain('Build POST /api/attendance');
    expect(output).toContain('React check-in form');
  });

  it('generates PARALLEL DISPATCH for 2-task wave without conflicts', () => {
    const wave = makeWave({
      waveNumber: 1,
      tasks: [
        makeTask({ id: 1, title: 'Task A', files: ['a.ts'] }),
        makeTask({ id: 2, title: 'Task B', files: ['b.ts'] }),
      ],
    });

    const output = formatWaveDispatchBlock(wave, 'feature');

    expect(output).toContain('2 tasks — PARALLEL DISPATCH');
    expect(output).toContain('Agent Spawn Commands');
  });
});

describe('formatDispatchSummary', () => {
  it('summarizes parallel and sequential waves', () => {
    const waves: ParallelWave[] = [
      makeWave({ waveNumber: 1, tasks: [makeTask({ id: 1 })] }),
      makeWave({
        waveNumber: 2,
        tasks: [makeTask({ id: 2 }), makeTask({ id: 3 }), makeTask({ id: 4 })],
      }),
      makeWave({ waveNumber: 3, isReviewCheckpoint: true }),
      makeWave({ waveNumber: 4, tasks: [makeTask({ id: 5 })], hasConflicts: true, fileConflicts: ['x.ts'] }),
    ];

    const output = formatDispatchSummary(waves);

    expect(output).toContain('Parallel waves:** 1 (3 agents total)');
    expect(output).toContain('Sequential waves:** 2');
    expect(output).toContain('Review checkpoints:** 1');
    expect(output).toContain('Model:** sonnet');
    expect(output).toContain('Lightweight parallel');
  });

  it('omits pattern note when no parallel waves', () => {
    const waves: ParallelWave[] = [
      makeWave({ waveNumber: 1, tasks: [makeTask({ id: 1 })] }),
      makeWave({ waveNumber: 2, tasks: [makeTask({ id: 2 })] }),
    ];

    const output = formatDispatchSummary(waves);

    expect(output).toContain('Parallel waves:** 0');
    expect(output).not.toContain('Lightweight parallel');
  });
});
