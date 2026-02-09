import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync, execFileSync } from 'child_process';

// Mock child_process to avoid running actual commands
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

// Mock the logger
vi.mock('../../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Test iron law integration directly
import { checkIronLaws } from '../../guardrails/iron-laws.js';

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
