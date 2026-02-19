import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync, execFileSync } from 'child_process';
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { recordTrustDecision } from './quality-ratchet.js';
import { createAntibodyCore } from './immune-system.js';
import { addDataPoint } from './shared/estimation.js';
import { proposeChecksFromLessons } from './crystallization.js';

// Mock child_process to avoid running actual commands
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

// Mock fs for deferred items
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  mkdirSync: vi.fn(),
}));

vi.mock('../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    radlDir: '/tmp/test-radl',
    radlOpsDir: '/tmp/test-ops',
    knowledgeDir: '/tmp/test-knowledge',
    usageLogsDir: '/tmp/test-logs',
    sprintScript: '/tmp/sprint.sh',
    compoundScript: '/tmp/compound.sh',
  })),
}));

vi.mock('../../integrations/google.js', () => ({
  isGoogleConfigured: vi.fn().mockReturnValue(false),
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
}));

// Mock the logger
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

vi.mock('./quality-ratchet.js', () => ({
  recordTrustDecision: vi.fn(),
}));

vi.mock('./cognitive-load.js', () => ({
  recordCognitiveCalibration: vi.fn(),
}));

vi.mock('./causal-graph.js', () => ({
  extractCausalPairs: vi.fn().mockResolvedValue({ pairs: 0 }),
}));

vi.mock('./immune-system.js', () => ({
  createAntibodyCore: vi.fn().mockResolvedValue({
    id: 1,
    trigger: 'test',
    triggerKeywords: ['test'],
    check: 'Verify test',
    checkType: 'manual',
    checkPattern: null,
    origin: { sprint: 'Phase 93', bug: 'test bug' },
    catches: 0,
    falsePositives: 0,
    falsePositiveRate: 0,
    active: true,
    createdAt: '2026-02-19T00:00:00.000Z',
  }),
}));

vi.mock('./crystallization.js', () => ({
  proposeChecksFromLessons: vi.fn().mockResolvedValue(0),
}));

vi.mock('./shared/estimation.js', () => ({
  addDataPoint: vi.fn(),
  inferTaskType: vi.fn().mockReturnValue('feature'),
  inferComplexity: vi.fn().mockReturnValue('medium'),
}));

vi.mock('../../models/token-tracker.js', () => ({
  setCurrentSprintPhase: vi.fn(),
}));

vi.mock('../resources.js', () => ({
  notifySprintChanged: vi.fn(),
}));

vi.mock('../../patterns/bloom-orchestrator.js', () => ({
  runBloomPipeline: vi.fn(),
}));

vi.mock('./shared/plan-store.js', () => ({
  loadLatestPlan: vi.fn().mockReturnValue(null),
  matchCommitsToTasks: vi.fn(),
  savePlan: vi.fn(),
  formatTraceabilityReport: vi.fn().mockReturnValue(''),
}));

// Test iron law integration directly
import { checkIronLaws } from '../../guardrails/iron-laws.js';

// Extract handlers by registering with a mock server
async function getHandlers() {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
  };

  const { registerSprintTools } = await import('./sprint.js');
  registerSprintTools(mockServer as any);
  return handlers;
}

describe('Sprint Tools - Iron Law Integration', () => {
  describe('sprint_start branch check', () => {
    it('blocks sprint start on main branch', () => {
      const result = checkIronLaws({
        action: 'git_push',
        toolName: 'sprint_start',
        gitBranch: 'main',
      });
      expect(result.passed).toBe(false);
      expect(result.violations[0].lawId).toBe('no-push-main');
    });

    it('allows sprint start on feature branch', () => {
      const result = checkIronLaws({
        action: 'git_push',
        toolName: 'sprint_start',
        gitBranch: 'feat/phase-55',
      });
      const mainViolation = result.violations.find(v => v.lawId === 'no-push-main');
      expect(mainViolation).toBeUndefined();
    });
  });

  describe('getCurrentBranch uses execSync', () => {
    beforeEach(() => {
      vi.mocked(execSync).mockReset();
    });

    it('returns branch name from git command', () => {
      vi.mocked(execSync).mockReturnValueOnce('feat/test-branch\n');
      const result = execSync('git branch --show-current', {
        encoding: 'utf-8',
        cwd: '/home/hb/radl',
        timeout: 5000,
      });
      expect((result as string).trim()).toBe('feat/test-branch');
    });

    it('handles git command failure', () => {
      vi.mocked(execSync).mockImplementationOnce(() => {
        throw new Error('git not found');
      });
      expect(() =>
        execSync('git branch --show-current', { encoding: 'utf-8' })
      ).toThrow('git not found');
    });
  });

  describe('runSprint uses execFileSync (no shell injection)', () => {
    beforeEach(() => {
      vi.mocked(execFileSync).mockReset();
    });

    it('calls sprint script with array args', () => {
      vi.mocked(execFileSync).mockReturnValueOnce('Phase: 55\nTitle: UX Overhaul\nStatus: active\n');
      const result = execFileSync('/home/hb/radl-ops/scripts/sprint.sh', ['status'], {
        encoding: 'utf-8',
        timeout: 30000,
      });
      expect(result).toContain('Phase: 55');
      expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
        '/home/hb/radl-ops/scripts/sprint.sh',
        ['status'],
        expect.objectContaining({ encoding: 'utf-8', timeout: 30000 })
      );
    });

    it('handles sprint command failure gracefully', () => {
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw new Error('No active sprint');
      });
      expect(() =>
        execFileSync('/home/hb/radl-ops/scripts/sprint.sh', ['status'], { encoding: 'utf-8' })
      ).toThrow('No active sprint');
    });
  });
});

describe('Sprint Tools - Task Count Advisory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execSync).mockReturnValue('feat/test\n');
    vi.mocked(execFileSync).mockReturnValue('Sprint started: Phase 62\n');
  });

  it('shows warning when task_count is 0', async () => {
    const handlers = await getHandlers();
    const result = await handlers['sprint_start']({
      phase: 'Phase 62',
      title: 'Test Sprint',
      task_count: 0,
    });
    const text = result.content[0].text;

    expect(text).toContain('WARNING: No task breakdown provided');
    expect(text).toContain('TaskCreate');
  });

  it('shows warning when task_count is omitted', async () => {
    const handlers = await getHandlers();
    const result = await handlers['sprint_start']({
      phase: 'Phase 62',
      title: 'Test Sprint',
    });
    const text = result.content[0].text;

    expect(text).toContain('WARNING: No task breakdown provided');
  });

  it('shows task plan when task_count is provided', async () => {
    const handlers = await getHandlers();
    const result = await handlers['sprint_start']({
      phase: 'Phase 62',
      title: 'Test Sprint',
      task_count: 5,
    });
    const text = result.content[0].text;

    expect(text).toContain('Task plan: 5 tasks');
    expect(text).not.toContain('WARNING');
  });
});

describe('Sprint Tools - Team Suggestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execSync).mockReturnValue('feat/test\n');
    vi.mocked(execFileSync).mockReturnValue('Sprint started: Phase 62\n');
  });

  it('suggests sprint_advisor for 3+ tasks', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const handlers = await getHandlers();
    const result = await handlers['sprint_start']({
      phase: 'Phase 62',
      title: 'Generic Sprint',
      task_count: 5,
    });
    const text = result.content[0].text;

    expect(text).toContain('sprint_advisor');
    expect(text).toContain('5 tasks detected');
  });

  it('suggests review recipe for review-related title', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const handlers = await getHandlers();
    const result = await handlers['sprint_start']({
      phase: 'Phase 62',
      title: 'Code Review Sprint',
      task_count: 2,
    });
    const text = result.content[0].text;

    expect(text).toContain('review recipe');
    expect(text).toContain('team_recipe');
  });

  it('suggests migration recipe for database-related title', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const handlers = await getHandlers();
    const result = await handlers['sprint_start']({
      phase: 'Phase 62',
      title: 'Database Schema Migration',
      task_count: 2,
    });
    const text = result.content[0].text;

    expect(text).toContain('migration recipe');
  });

  it('includes historical team run context', async () => {
    const existingStore = {
      runs: [
        { id: 1, sprintPhase: 'Phase 60', recipe: 'review', teammateCount: 3, model: 'sonnet', duration: '5 min', outcome: 'success', date: '2026-02-10' },
      ],
    };
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(existingStore));

    const handlers = await getHandlers();
    const result = await handlers['sprint_start']({
      phase: 'Phase 62',
      title: 'Generic Sprint',
      task_count: 1,
    });
    const text = result.content[0].text;

    expect(text).toContain('Last successful team');
    expect(text).toContain('review recipe');
    expect(text).toContain('Phase 60');
  });

  it('shows no suggestion when no keywords match and few tasks', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const handlers = await getHandlers();
    const result = await handlers['sprint_start']({
      phase: 'Phase 62',
      title: 'Bug Fix',
      task_count: 1,
    });
    const text = result.content[0].text;

    expect(text).not.toContain('Team suggestion');
    expect(text).not.toContain('sprint_advisor');
  });
});

describe('Sprint Tools - Team Used Tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execSync).mockReturnValue('feat/test\n');
    vi.mocked(execFileSync).mockReturnValue('Sprint completed: Phase 62\n');
  });

  it('completes sprint without team_used', async () => {
    const handlers = await getHandlers();
    const result = await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
    });
    const text = result.content[0].text;

    expect(text).toContain('Sprint completed');
    expect(text).not.toContain('Team run tracked');
  });

  it('tracks team run when team_used is provided', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const handlers = await getHandlers();
    const result = await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
      team_used: {
        recipe: 'review',
        teammateCount: 3,
        model: 'sonnet',
        duration: '5 minutes',
        findingsCount: 12,
        outcome: 'success',
      },
    });
    const text = result.content[0].text;

    expect(text).toContain('Team run tracked: review recipe, 3 teammates, outcome: success');

    // Verify atomic write
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining('team-runs.json.tmp'),
      expect.any(String),
      'utf-8'
    );
    expect(vi.mocked(renameSync)).toHaveBeenCalled();

    const writtenJson = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    expect(writtenJson.runs).toHaveLength(1);
    expect(writtenJson.runs[0].id).toBe(1);
    expect(writtenJson.runs[0].recipe).toBe('review');
    expect(writtenJson.runs[0].teammateCount).toBe(3);
    expect(writtenJson.runs[0].outcome).toBe('success');
    expect(writtenJson.runs[0].findingsCount).toBe(12);
  });

  it('appends to existing team runs with correct IDs', async () => {
    const existingStore = {
      runs: [
        { id: 1, sprintPhase: 'Phase 60', recipe: 'review', teammateCount: 3, model: 'sonnet', duration: '5 min', outcome: 'success', date: '2026-02-10' },
        { id: 3, sprintPhase: 'Phase 61', recipe: 'debug', teammateCount: 3, model: 'sonnet', duration: '8 min', outcome: 'partial', date: '2026-02-11' },
      ],
    };
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(existingStore));

    const handlers = await getHandlers();
    await handlers['sprint_complete']({
      commit: 'def5678',
      actual_time: '2 hours',
      team_used: {
        recipe: 'feature',
        teammateCount: 3,
        model: 'sonnet',
        duration: '10 min',
        outcome: 'success',
      },
    });

    const writtenJson = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    expect(writtenJson.runs).toHaveLength(3);
    // Next ID should be max(1, 3) + 1 = 4
    expect(writtenJson.runs[2].id).toBe(4);
    expect(writtenJson.runs[2].recipe).toBe('feature');
  });

  it('handles both deferred_items and team_used in same call', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const handlers = await getHandlers();
    const result = await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
      deferred_items: [
        { title: 'Tech debt', reason: 'Low priority', effort: 'small' },
      ],
      team_used: {
        recipe: 'review',
        teammateCount: 3,
        model: 'sonnet',
        duration: '5 min',
        outcome: 'success',
      },
    });
    const text = result.content[0].text;

    expect(text).toContain('Deferred items: 1');
    expect(text).toContain('Team run tracked');
    // 2 write calls: one for deferred, one for team runs
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(2);
  });

  it('stores lessonsLearned when provided', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const handlers = await getHandlers();
    await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
      team_used: {
        recipe: 'review',
        teammateCount: 3,
        model: 'sonnet',
        duration: '5 min',
        outcome: 'success',
        lessonsLearned: 'Sonnet finds same issues as Opus at lower cost',
      },
    });

    const writtenJson = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    expect(writtenJson.runs[0].lessonsLearned).toBe('Sonnet finds same issues as Opus at lower cost');
  });
});

describe('Sprint Tools - Deferred Items', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execSync).mockReturnValue('feat/test\n');
    vi.mocked(execFileSync).mockReturnValue('Sprint completed: Phase 62\n');
  });

  it('completes sprint without deferred items', async () => {
    const handlers = await getHandlers();
    const result = await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
    });
    const text = result.content[0].text;

    expect(text).toContain('Sprint completed');
    expect(text).not.toContain('Deferred items');
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });

  it('tracks deferred items when provided', async () => {
    vi.mocked(existsSync).mockReturnValue(false); // No existing deferred.json

    const handlers = await getHandlers();
    const result = await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
      deferred_items: [
        { title: 'CASL migration', reason: 'Too large for this sprint', effort: 'large' },
        { title: 'Query optimization', reason: 'Low priority', effort: 'small' },
      ],
    });
    const text = result.content[0].text;

    expect(text).toContain('Deferred items: 2');
    expect(text).toContain('knowledge/deferred.json');

    // Verify atomic write (temp file + rename)
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      expect.any(String),
      'utf-8'
    );
    expect(vi.mocked(renameSync)).toHaveBeenCalled();

    // Verify written JSON content
    const writtenJson = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    expect(writtenJson.items).toHaveLength(2);
    expect(writtenJson.items[0].id).toBe(1);
    expect(writtenJson.items[0].title).toBe('CASL migration');
    expect(writtenJson.items[0].effort).toBe('large');
    expect(writtenJson.items[0].resolved).toBe(false);
    expect(writtenJson.items[1].id).toBe(2);
  });

  it('appends to existing deferred items with correct IDs', async () => {
    const existingStore = {
      items: [
        { id: 1, title: 'Existing', reason: 'old', effort: 'small', sprintPhase: 'Phase 60', date: '2026-02-10', resolved: false },
        { id: 5, title: 'Existing 2', reason: 'old', effort: 'medium', sprintPhase: 'Phase 61', date: '2026-02-11', resolved: true },
      ],
    };
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(existingStore));

    const handlers = await getHandlers();
    await handlers['sprint_complete']({
      commit: 'def5678',
      actual_time: '2 hours',
      deferred_items: [
        { title: 'New item', reason: 'deferred', effort: 'medium' },
      ],
    });

    const writtenJson = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    expect(writtenJson.items).toHaveLength(3);
    // Next ID should be max(1, 5) + 1 = 6
    expect(writtenJson.items[2].id).toBe(6);
    expect(writtenJson.items[2].title).toBe('New item');
  });

  it('parses sprint phase from output', async () => {
    vi.mocked(execFileSync).mockReturnValue('Sprint completed: Phase 62.1 done\n');
    vi.mocked(existsSync).mockReturnValue(false);

    const handlers = await getHandlers();
    await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
      deferred_items: [
        { title: 'Test', reason: 'test', effort: 'small' },
      ],
    });

    const writtenJson = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    expect(writtenJson.items[0].sprintPhase).toBe('Phase 62.1');
  });

  it('uses Unknown when phase cannot be parsed', async () => {
    vi.mocked(execFileSync).mockReturnValue('Sprint completed successfully\n');
    vi.mocked(existsSync).mockReturnValue(false);

    const handlers = await getHandlers();
    await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
      deferred_items: [
        { title: 'Test', reason: 'test', effort: 'small' },
      ],
    });

    const writtenJson = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    expect(writtenJson.items[0].sprintPhase).toBe('Unknown');
  });

  it('handles corrupted deferred.json gracefully', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('not valid json {{{');

    const handlers = await getHandlers();
    const result = await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
      deferred_items: [
        { title: 'Test', reason: 'test', effort: 'small' },
      ],
    });

    // Should still complete successfully, starting IDs from 1
    const writtenJson = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    expect(writtenJson.items[0].id).toBe(1);
    expect(result.content[0].text).toContain('Deferred items: 1');
  });
});

describe('Sprint Tools - Validation Warning Comparison', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty string when plan has no validation warnings', async () => {
    const { compareValidationWarnings } = await import('./sprint.js');

    const result = compareValidationWarnings({}, '/tmp/test', 'Phase 80');
    expect(result).toBe('');
  });

  it('returns empty string when validationWarnings array is empty', async () => {
    const { compareValidationWarnings } = await import('./sprint.js');

    const result = compareValidationWarnings({ validationWarnings: [] }, '/tmp/test', 'Phase 80');
    expect(result).toBe('');
  });

  it('marks data-flow warning as FIXED when all missing layers are in diff', async () => {
    vi.mocked(execSync).mockReturnValueOnce(
      'src/app/api/test/route.ts\nsrc/components/test/form.tsx\n'
    );

    const { compareValidationWarnings } = await import('./sprint.js');

    const result = compareValidationWarnings({
      validationWarnings: [
        '[HIGH] data-flow-coverage: Prisma schema changes detected but missing: api-handler, client-component',
      ],
    }, '/tmp/test', 'Phase 80');

    expect(result).toContain('FIXED');
    expect(result).toContain('Addressed:** 1');
    expect(recordTrustDecision).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'speculative_validation',
      outcome: 'success',
      sprint: 'Phase 80',
    }));
  });

  it('marks warning as PARTIAL when some layers are in diff', async () => {
    vi.mocked(execSync).mockReturnValueOnce(
      'src/app/api/test/route.ts\n'
    );

    const { compareValidationWarnings } = await import('./sprint.js');

    const result = compareValidationWarnings({
      validationWarnings: [
        '[CRITICAL] data-flow-coverage: Prisma schema changes detected but missing: api-handler, client-component',
      ],
    }, '/tmp/test', 'Phase 80');

    expect(result).toContain('PARTIAL');
    expect(result).toContain('1/2 layers');
  });

  it('marks warning as OPEN when no layers are in diff', async () => {
    vi.mocked(execSync).mockReturnValueOnce(
      'prisma/schema.prisma\n'
    );

    const { compareValidationWarnings } = await import('./sprint.js');

    const result = compareValidationWarnings({
      validationWarnings: [
        '[HIGH] data-flow-coverage: Prisma schema changes detected but missing: api-handler, client-component',
      ],
    }, '/tmp/test', 'Phase 80');

    expect(result).toContain('OPEN');
    expect(recordTrustDecision).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure',
    }));
  });

  it('marks non-data-flow warnings as REVIEW', async () => {
    vi.mocked(execSync).mockReturnValueOnce('src/app/api/test/route.ts\n');

    const { compareValidationWarnings } = await import('./sprint.js');

    const result = compareValidationWarnings({
      validationWarnings: [
        '[HIGH] antibody-match: Antibody #3: Missing team scope in query',
      ],
    }, '/tmp/test', 'Phase 80');

    expect(result).toContain('REVIEW');
  });

  it('returns empty string when git diff fails', async () => {
    vi.mocked(execSync).mockImplementationOnce(() => { throw new Error('git error'); });

    const { compareValidationWarnings } = await import('./sprint.js');

    const result = compareValidationWarnings({
      validationWarnings: ['[HIGH] some warning'],
    }, '/tmp/test', 'Phase 80');

    expect(result).toBe('');
  });

  it('handles multiple warnings with mixed results', async () => {
    vi.mocked(execSync).mockReturnValueOnce(
      'src/app/api/test/route.ts\nsrc/lib/validations/test.ts\nsrc/components/test.tsx\n'
    );

    const { compareValidationWarnings } = await import('./sprint.js');

    const result = compareValidationWarnings({
      validationWarnings: [
        '[HIGH] data-flow-coverage: Prisma changes but missing: api-handler, validation, client-component',
        '[MEDIUM] crystallized-check: Check #5: Always validate inputs',
      ],
    }, '/tmp/test', 'Phase 80');

    expect(result).toContain('FIXED');
    expect(result).toContain('REVIEW');
    expect(result).toContain('Pre-sprint warnings:** 2');
    expect(recordTrustDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: '1/2 warnings addressed',
      outcome: 'partial',
    }));
  });
});

describe('Sprint Tools - Quality Gates (D1-D3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execSync).mockReturnValue('feat/test\n');
  });

  it('D1: warns when 0 tasks recorded', async () => {
    vi.mocked(execFileSync).mockReturnValue('Sprint completed: Phase 92\n');
    vi.mocked(existsSync).mockReturnValue(false);

    const handlers = await getHandlers();
    const result = await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
      auto_extract: false,
    });
    const text = result.content[0].text;

    expect(text).toContain('QUALITY: 0 tasks recorded');
  });

  it('D1: notes single task on 2h+ sprint', async () => {
    vi.mocked(execFileSync).mockReturnValue('Sprint completed: Phase 92 — 1 task completed\n');
    // Return sprint data with 1 task and 2h estimate
    const sprintData = {
      phase: 'Phase 92',
      title: 'Test Sprint',
      status: 'completed',
      estimate: '2 hours',
      completedTasks: ['task 1'],
      blockers: [],
    };
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('completed-')) return false;
      if (typeof p === 'string' && p.includes('current.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(sprintData));
    vi.mocked(readdirSync).mockReturnValue([] as any);

    const handlers = await getHandlers();
    const result = await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
      auto_extract: false,
    });
    const text = result.content[0].text;

    expect(text).toContain('QUALITY NOTE: 1 task on a');
  });

  it('D2: notes when 0 blockers recorded (with sprint data)', async () => {
    const sprintData = {
      phase: 'Phase 92',
      title: 'Test Sprint',
      status: 'completed',
      estimate: '1 hour',
      completedTasks: ['task 1'],
      blockers: [],
    };
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('current.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(sprintData));
    vi.mocked(readdirSync).mockReturnValue([] as any);
    vi.mocked(execFileSync).mockReturnValue('Sprint completed: Phase 92\n');

    const handlers = await getHandlers();
    const result = await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
      auto_extract: false,
    });
    const text = result.content[0].text;

    expect(text).toContain('QUALITY NOTE: 0 blockers recorded');
  });

  it('D2: does not fire when no sprint data exists', async () => {
    vi.mocked(execFileSync).mockReturnValue('Sprint completed: Phase 92\n');
    vi.mocked(existsSync).mockReturnValue(false);

    const handlers = await getHandlers();
    const result = await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
      auto_extract: false,
    });
    const text = result.content[0].text;

    expect(text).not.toContain('QUALITY NOTE: 0 blockers recorded');
  });

  it('D3: warns when actual < 30% of estimate', async () => {
    const sprintData = {
      phase: 'Phase 92',
      title: 'Test Sprint',
      status: 'completed',
      estimate: '3 hours',
      completedTasks: ['task 1', 'task 2'],
      blockers: [],
    };
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('completed-')) return false;
      if (typeof p === 'string' && p.includes('current.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(sprintData));
    vi.mocked(readdirSync).mockReturnValue([] as any);
    vi.mocked(execFileSync).mockReturnValue('Sprint completed: Phase 92\n');

    const handlers = await getHandlers();
    const result = await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '30 minutes',
      auto_extract: false,
    });
    const text = result.content[0].text;

    expect(text).toContain('QUALITY: Actual');
    expect(text).toContain('<30% of estimate');
  });
});

describe('Sprint Tools - Estimation Auto-Record (A1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execSync).mockReturnValue('feat/test\n');
    vi.mocked(execFileSync).mockReturnValue('Sprint completed: Phase 92\n');
  });

  it('calls addDataPoint when estimate and actual_time exist', async () => {
    const sprintData = {
      phase: 'Phase 92',
      title: 'Feature Sprint',
      status: 'completed',
      estimate: '2 hours',
      completedTasks: ['task1', 'task2', 'task3'],
      blockers: [],
    };
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('completed-')) return false;
      if (typeof p === 'string' && p.includes('current.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(sprintData));
    vi.mocked(readdirSync).mockReturnValue([] as any);

    const handlers = await getHandlers();
    await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
    });

    expect(addDataPoint).toHaveBeenCalledWith(expect.objectContaining({
      sprintPhase: expect.stringContaining('Phase 92'),
      estimatedMinutes: 120,
      actualMinutes: 60,
    }));
  });

  it('does not call addDataPoint when auto_extract is false', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const handlers = await getHandlers();
    await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
      auto_extract: false,
    });

    expect(addDataPoint).not.toHaveBeenCalled();
  });
});

describe('Sprint Tools - Antibody Auto-Create (A2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execSync).mockReturnValue('feat/test\n');
    vi.mocked(execFileSync).mockReturnValue('Sprint completed: Phase 92\n');
  });

  it('calls createAntibodyCore for CRITICAL/HIGH findings', async () => {
    // Mock review-tracker loadFindings to return findings
    const reviewTracker = await import('./review-tracker.js');
    vi.spyOn(reviewTracker, 'loadFindings').mockReturnValue([
      { id: 'f1', severity: 'CRITICAL', file: 'test.ts', description: 'SQL injection vulnerability', reviewer: 'security', resolved: false, recordedAt: new Date().toISOString() },
      { id: 'f2', severity: 'HIGH', file: 'auth.ts', description: 'Auth bypass possible', reviewer: 'security', resolved: false, recordedAt: new Date().toISOString() },
      { id: 'f3', severity: 'MEDIUM', file: 'ui.ts', description: 'Minor style issue', reviewer: 'code', resolved: false, recordedAt: new Date().toISOString() },
    ]);
    vi.spyOn(reviewTracker, 'checkUnresolved').mockReturnValue({ critical: 0, high: 0, medium: 0, low: 0 });

    vi.mocked(existsSync).mockReturnValue(false);

    const handlers = await getHandlers();
    const result = await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
      auto_extract: true,
    });
    const text = result.content[0].text;

    // Should be called for CRITICAL and HIGH, not MEDIUM
    expect(createAntibodyCore).toHaveBeenCalledTimes(2);
    expect(createAntibodyCore).toHaveBeenCalledWith(
      'SQL injection vulnerability',
      undefined,
      expect.stringContaining('Phase 92'),
    );
    expect(createAntibodyCore).toHaveBeenCalledWith(
      'Auth bypass possible',
      undefined,
      expect.stringContaining('Phase 92'),
    );
    expect(text).toContain('Antibodies created: 2');
  });

  it('caps at 3 antibodies per sprint', async () => {
    const reviewTracker = await import('./review-tracker.js');
    vi.spyOn(reviewTracker, 'loadFindings').mockReturnValue([
      { id: 'f1', severity: 'CRITICAL', file: 'a.ts', description: 'Bug 1', reviewer: 'sec', resolved: false, recordedAt: new Date().toISOString() },
      { id: 'f2', severity: 'CRITICAL', file: 'b.ts', description: 'Bug 2', reviewer: 'sec', resolved: false, recordedAt: new Date().toISOString() },
      { id: 'f3', severity: 'HIGH', file: 'c.ts', description: 'Bug 3', reviewer: 'sec', resolved: false, recordedAt: new Date().toISOString() },
      { id: 'f4', severity: 'HIGH', file: 'd.ts', description: 'Bug 4', reviewer: 'sec', resolved: false, recordedAt: new Date().toISOString() },
    ]);
    vi.spyOn(reviewTracker, 'checkUnresolved').mockReturnValue({ critical: 0, high: 0, medium: 0, low: 0 });

    vi.mocked(existsSync).mockReturnValue(false);

    const handlers = await getHandlers();
    await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
      auto_extract: true,
    });

    // Should only be called 3 times despite 4 CRITICAL/HIGH findings
    expect(createAntibodyCore).toHaveBeenCalledTimes(3);
  });

  it('does not create antibodies when no findings', async () => {
    const reviewTracker = await import('./review-tracker.js');
    vi.spyOn(reviewTracker, 'loadFindings').mockReturnValue([]);
    vi.spyOn(reviewTracker, 'checkUnresolved').mockReturnValue({ critical: 0, high: 0, medium: 0, low: 0 });

    vi.mocked(existsSync).mockReturnValue(false);

    const handlers = await getHandlers();
    await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
      auto_extract: true,
    });

    expect(createAntibodyCore).not.toHaveBeenCalled();
  });
});

describe('Sprint Tools - Crystallize Auto-Propose (A3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execSync).mockReturnValue('feat/test\n');
    vi.mocked(execFileSync).mockReturnValue('Sprint completed: Phase 92\n');
  });

  it('triggers proposeChecksFromLessons at every 5th bloom file', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(
      Array.from({ length: 5 }, (_, i) => `bloom-2026-0${i + 1}.json`) as any,
    );
    vi.mocked(readFileSync).mockReturnValue('{}');

    const handlers = await getHandlers();
    await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
    });

    expect(proposeChecksFromLessons).toHaveBeenCalledWith(1);
  });

  it('does not trigger proposeChecksFromLessons at non-multiple of 5', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(
      Array.from({ length: 3 }, (_, i) => `bloom-2026-0${i + 1}.json`) as any,
    );
    vi.mocked(readFileSync).mockReturnValue('{}');

    const handlers = await getHandlers();
    await handlers['sprint_complete']({
      commit: 'abc1234',
      actual_time: '1 hour',
    });

    expect(proposeChecksFromLessons).not.toHaveBeenCalled();
  });
});
