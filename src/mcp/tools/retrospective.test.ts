import { describe, it, expect, vi } from 'vitest';
import { runRetrospective, formatRetroReport, getCommitMessages } from './retrospective.js';
import type { RetroResult } from './retrospective.js';
import type { StoredPlan } from './shared/plan-store.js';

// Mock dependencies
vi.mock('../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    knowledgeDir: '/tmp/test-knowledge',
    radlDir: '/home/hb/radl',
    sprintDir: '/tmp/test-sprints',
    opsDir: '/home/hb/radl-ops',
  })),
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
}));

import { execSync } from 'child_process';

function makePlan(overrides: Partial<StoredPlan> = {}): StoredPlan {
  return {
    id: '20260214-test',
    feature: 'Test feature',
    createdAt: '2026-02-14T00:00:00.000Z',
    tasks: [
      { id: 1, title: 'Add user model', type: 'feature', files: ['src/models/user.ts'], estimateMinutes: 30, status: 'planned' },
      { id: 2, title: 'Create API endpoint', type: 'feature', files: ['src/api/users.ts'], estimateMinutes: 20, status: 'planned' },
      { id: 3, title: 'Write unit tests', type: 'test', files: ['src/tests/user.test.ts'], estimateMinutes: 15, status: 'planned' },
    ],
    unplannedCommits: [],
    ...overrides,
  };
}

describe('getCommitMessages', () => {
  it('returns parsed commit messages', () => {
    vi.mocked(execSync).mockReturnValue('feat: add user model\nfix: typo\n');
    const messages = getCommitMessages('/home/hb/radl', 'HEAD~5..HEAD');
    expect(messages).toEqual(['feat: add user model', 'fix: typo']);
  });

  it('returns empty array on error', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not a repo'); });
    expect(getCommitMessages('/nope', 'HEAD~5..HEAD')).toEqual([]);
  });

  it('returns empty array for empty output', () => {
    vi.mocked(execSync).mockReturnValue('');
    expect(getCommitMessages('/home/hb/radl', 'HEAD~5..HEAD')).toEqual([]);
  });
});

describe('runRetrospective', () => {
  it('matches commits to planned tasks', () => {
    const plan = makePlan();
    const commits = ['feat: add user model with validation', 'feat: create API endpoint for users'];

    const result = runRetrospective(plan, commits);
    expect(result.committed).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.totalPlanned).toBe(3);
  });

  it('flags unplanned commits', () => {
    const plan = makePlan();
    const commits = ['fix: random hotfix', 'chore: update deps'];

    const result = runRetrospective(plan, commits);
    expect(result.unplannedCommits).toBe(2);
  });

  it('computes estimation accuracy when actual time provided', () => {
    const plan = makePlan();
    const commits = ['feat: add user model'];

    const result = runRetrospective(plan, commits, 60);
    expect(result.estimationAccuracy).toBe(92); // 60 / 65 * 100
    expect(result.totalEstimatedMinutes).toBe(65);
  });

  it('returns null accuracy when no actual time', () => {
    const plan = makePlan();
    const result = runRetrospective(plan, []);
    expect(result.estimationAccuracy).toBeNull();
  });
});

describe('formatRetroReport', () => {
  it('formats basic report', () => {
    const result: RetroResult = {
      planId: '20260214-test',
      feature: 'Test feature',
      totalPlanned: 3,
      committed: 2,
      skipped: 1,
      unplannedCommits: 1,
      estimationAccuracy: 92,
      totalEstimatedMinutes: 65,
      commitMessages: ['feat: add user model', 'feat: create API'],
    };

    const output = formatRetroReport(result);
    expect(output).toContain('Sprint Retrospective');
    expect(output).toContain('2/3');
    expect(output).toContain('67%');
    expect(output).toContain('1 planned tasks not matched');
    expect(output).toContain('92%');
    expect(output).toContain('Good estimate');
  });

  it('flags under-estimation', () => {
    const result: RetroResult = {
      planId: 'test',
      feature: 'Test',
      totalPlanned: 3,
      committed: 3,
      skipped: 0,
      unplannedCommits: 0,
      estimationAccuracy: 50,
      totalEstimatedMinutes: 60,
      commitMessages: [],
    };

    const output = formatRetroReport(result);
    expect(output).toContain('Under-estimated');
  });

  it('flags over-estimation', () => {
    const result: RetroResult = {
      planId: 'test',
      feature: 'Test',
      totalPlanned: 3,
      committed: 3,
      skipped: 0,
      unplannedCommits: 0,
      estimationAccuracy: 150,
      totalEstimatedMinutes: 120,
      commitMessages: [],
    };

    const output = formatRetroReport(result);
    expect(output).toContain('Over-estimated');
  });
});
