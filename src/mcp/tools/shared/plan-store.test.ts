import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generatePlanId,
  createPlanFromDecomposition,
  matchCommitsToTasks,
  fuzzyMatch,
  formatTraceabilityReport,
  savePlan,
  loadPlan,
  loadLatestPlan,
  updateTaskStatus,
} from './plan-store.js';
import type { StoredPlan } from './plan-store.js';
import type { DecomposedTask } from './decomposition.js';

// Mock dependencies
vi.mock('../../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    knowledgeDir: '/tmp/test-knowledge',
    radlDir: '/home/hb/radl',
    sprintDir: '/tmp/test-sprints',
    opsDir: '/home/hb/radl-ops',
  })),
}));

vi.mock('../../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  readdirSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';

function makePlan(overrides: Partial<StoredPlan> = {}): StoredPlan {
  return {
    id: '20260214-test-feature',
    feature: 'Test feature',
    createdAt: '2026-02-14T00:00:00.000Z',
    tasks: [
      { id: 1, title: 'Add user model', type: 'feature', files: ['src/models/user.ts'], estimateMinutes: 30, status: 'planned' },
      { id: 2, title: 'Create API endpoint', type: 'feature', files: ['src/api/users.ts'], estimateMinutes: 20, status: 'planned' },
    ],
    unplannedCommits: [],
    ...overrides,
  };
}

function makeTask(overrides: Partial<DecomposedTask> = {}): DecomposedTask {
  return {
    id: 1,
    title: 'Test task',
    description: 'A test task',
    activeForm: 'Testing',
    type: 'feature',
    files: ['src/a.ts'],
    dependsOn: [],
    estimateMinutes: 30,
    ...overrides,
  };
}

describe('generatePlanId', () => {
  it('generates ID from date and slugified feature', () => {
    const id = generatePlanId('Add practice attendance tracking');
    expect(id).toMatch(/^\d{8}-add-practice-attendance-track/);
  });

  it('handles special characters in feature name', () => {
    const id = generatePlanId('Fix bug #123 (urgent!)');
    expect(id).toMatch(/^\d{8}-fix-bug-123-urgent/);
  });
});

describe('createPlanFromDecomposition', () => {
  it('creates plan from decomposed tasks', () => {
    const tasks = [
      makeTask({ id: 1, title: 'Task A', files: ['a.ts'] }),
      makeTask({ id: 2, title: 'Task B', files: ['b.ts'] }),
    ];

    const plan = createPlanFromDecomposition('My feature', tasks);

    expect(plan.feature).toBe('My feature');
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0].status).toBe('planned');
    expect(plan.tasks[1].status).toBe('planned');
    expect(plan.unplannedCommits).toHaveLength(0);
    expect(plan.createdAt).toBeTruthy();
  });
});

describe('fuzzyMatch', () => {
  it('matches when >60% of title words appear in commit', () => {
    expect(fuzzyMatch('feat: add user model with validation', 'Add user model')).toBe(true);
  });

  it('does not match unrelated commit', () => {
    expect(fuzzyMatch('fix: update CSS styles', 'Add user model')).toBe(false);
  });

  it('ignores stop words', () => {
    expect(fuzzyMatch('feat: create the API endpoint', 'Create API endpoint for users')).toBe(true);
  });

  it('handles empty title', () => {
    expect(fuzzyMatch('some commit', '')).toBe(false);
  });

  it('is case insensitive', () => {
    expect(fuzzyMatch('FEAT: ADD USER MODEL', 'add user model')).toBe(true);
  });
});

describe('matchCommitsToTasks', () => {
  it('marks matched tasks as committed', () => {
    const plan = makePlan();
    const commits = ['feat: add user model with tests', 'chore: update deps'];

    const result = matchCommitsToTasks(plan, commits);
    expect(result.tasks[0].status).toBe('committed');
    expect(result.tasks[1].status).toBe('planned'); // not matched
  });

  it('tracks unplanned commits', () => {
    const plan = makePlan();
    const commits = ['fix: random hotfix', 'chore: update deps'];

    const result = matchCommitsToTasks(plan, commits);
    expect(result.unplannedCommits).toContain('fix: random hotfix');
    expect(result.unplannedCommits).toContain('chore: update deps');
  });

  it('handles empty commit list', () => {
    const plan = makePlan();
    const result = matchCommitsToTasks(plan, []);
    expect(result.tasks.every(t => t.status === 'planned')).toBe(true);
    expect(result.unplannedCommits).toHaveLength(0);
  });
});

describe('formatTraceabilityReport', () => {
  it('shows committed vs missed counts', () => {
    const plan = makePlan({
      tasks: [
        { id: 1, title: 'Done task', type: 'feature', files: [], estimateMinutes: 30, status: 'committed' },
        { id: 2, title: 'Missed task', type: 'feature', files: [], estimateMinutes: 20, status: 'planned' },
      ],
    });

    const report = formatTraceabilityReport(plan);
    expect(report).toContain('1/2 planned tasks committed');
    expect(report).toContain('1 not matched');
    expect(report).toContain('OK');
    expect(report).toContain('MISS');
  });

  it('shows unplanned commits', () => {
    const plan = makePlan({
      unplannedCommits: ['fix: hotfix', 'chore: deps'],
    });

    const report = formatTraceabilityReport(plan);
    expect(report).toContain('**Unplanned commits:** 2');
    expect(report).toContain('fix: hotfix');
  });
});

describe('savePlan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes plan as JSON with atomic rename', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const plan = makePlan();

    savePlan(plan);

    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      expect.stringContaining('"id"'),
    );
  });
});

describe('loadPlan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(loadPlan('nonexistent')).toBeNull();
  });

  it('loads and parses plan JSON', () => {
    const plan = makePlan();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(plan));

    const result = loadPlan(plan.id);
    expect(result?.id).toBe(plan.id);
    expect(result?.tasks).toHaveLength(2);
  });
});

describe('loadLatestPlan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when plans directory does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(loadLatestPlan()).toBeNull();
  });

  it('returns most recent plan (sorted reverse)', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([
      '20260210-old.json' as never,
      '20260214-new.json' as never,
    ]);
    const plan = makePlan({ id: '20260214-new' });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(plan));

    const result = loadLatestPlan();
    expect(result?.id).toBe('20260214-new');
  });
});

describe('updateTaskStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns false when plan does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(updateTaskStatus('nonexistent', 1, 'committed')).toBe(false);
  });

  it('updates task status and saves', () => {
    const plan = makePlan();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(plan));

    const result = updateTaskStatus(plan.id, 1, 'committed');
    expect(result).toBe(true);
    expect(writeFileSync).toHaveBeenCalled();
  });
});
