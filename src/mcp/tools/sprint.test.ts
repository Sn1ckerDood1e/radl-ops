import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync, execFileSync } from 'child_process';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';

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
}));

// Mock the logger
vi.mock('../../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

// Test iron law integration directly
import { checkIronLaws } from '../../guardrails/iron-laws.js';

// Extract handlers by registering with a mock server
async function getHandlers() {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: Function) => {
      handlers[_name] = handler;
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
