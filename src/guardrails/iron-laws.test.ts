import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkIronLaws,
  recordError,
  clearError,
  getErrorCount,
  getIronLaws,
} from './iron-laws.js';

describe('Iron Laws', () => {
  describe('getIronLaws', () => {
    it('returns all 6 iron laws', () => {
      const laws = getIronLaws();
      expect(laws).toHaveLength(6);
    });

    it('all laws have required fields', () => {
      const laws = getIronLaws();
      for (const law of laws) {
        expect(law.id).toBeTruthy();
        expect(law.description).toBeTruthy();
        expect(['block', 'warn']).toContain(law.severity);
      }
    });
  });

  describe('checkIronLaws - no-push-main', () => {
    it('blocks push to main branch', () => {
      const result = checkIronLaws({
        action: 'git_push',
        gitBranch: 'main',
      });
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].lawId).toBe('no-push-main');
    });

    it('blocks push to master branch', () => {
      const result = checkIronLaws({
        action: 'git_push',
        gitBranch: 'master',
      });
      expect(result.passed).toBe(false);
      expect(result.violations[0].lawId).toBe('no-push-main');
    });

    it('allows push to feature branch', () => {
      const result = checkIronLaws({
        action: 'git_push',
        gitBranch: 'feature/new-thing',
      });
      // no-push-main should not trigger
      const mainViolation = result.violations.find(v => v.lawId === 'no-push-main');
      expect(mainViolation).toBeUndefined();
    });
  });

  describe('checkIronLaws - no-delete-prod-data', () => {
    it('blocks production data deletion', () => {
      const result = checkIronLaws({
        action: 'database_operation',
        params: { operation: 'delete', environment: 'production' },
      });
      expect(result.passed).toBe(false);
      expect(result.violations[0].lawId).toBe('no-delete-prod-data');
    });

    it('allows development data deletion', () => {
      const result = checkIronLaws({
        action: 'database_operation',
        params: { operation: 'delete', environment: 'development' },
      });
      const violation = result.violations.find(v => v.lawId === 'no-delete-prod-data');
      expect(violation).toBeUndefined();
    });
  });

  describe('checkIronLaws - no-commit-secrets', () => {
    it('blocks committing .env files', () => {
      const result = checkIronLaws({
        action: 'file_write',
        targetFile: '/home/hb/radl/.env.local',
        params: { isGitTracked: true },
      });
      expect(result.passed).toBe(false);
      expect(result.violations[0].lawId).toBe('no-commit-secrets');
    });

    it('detects API keys in content', () => {
      const result = checkIronLaws({
        action: 'file_write',
        targetFile: 'src/config.ts',
        params: { content: 'const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"' },
      });
      expect(result.passed).toBe(false);
    });

    it('detects AWS access keys', () => {
      const result = checkIronLaws({
        action: 'file_write',
        targetFile: 'src/aws.ts',
        params: { content: 'const key = "AKIAIOSFODNN7EXAMPLE"' },
      });
      expect(result.passed).toBe(false);
    });

    it('detects GitHub tokens', () => {
      const result = checkIronLaws({
        action: 'file_write',
        targetFile: 'src/gh.ts',
        params: { content: 'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh"' },
      });
      expect(result.passed).toBe(false);
    });

    it('detects JWT tokens', () => {
      const result = checkIronLaws({
        action: 'file_write',
        targetFile: 'src/auth.ts',
        params: { content: 'const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0"' },
      });
      expect(result.passed).toBe(false);
    });

    it('detects database URLs with credentials', () => {
      const result = checkIronLaws({
        action: 'file_write',
        targetFile: 'src/db.ts',
        params: { content: 'const url = "postgres://admin:password123@host:5432/db"' },
      });
      expect(result.passed).toBe(false);
    });

    it('allows normal code content', () => {
      const result = checkIronLaws({
        action: 'file_write',
        targetFile: 'src/utils.ts',
        params: { content: 'export function add(a: number, b: number): number { return a + b; }' },
      });
      const secretViolation = result.violations.find(v => v.lawId === 'no-commit-secrets');
      expect(secretViolation).toBeUndefined();
    });
  });

  describe('checkIronLaws - three-strike-escalation', () => {
    it('blocks after 3 errors', () => {
      const result = checkIronLaws({
        action: 'tool_execution',
        errorCount: 3,
      });
      expect(result.passed).toBe(false);
      expect(result.violations[0].lawId).toBe('three-strike-escalation');
    });

    it('allows under 3 errors', () => {
      const result = checkIronLaws({
        action: 'tool_execution',
        errorCount: 2,
      });
      const violation = result.violations.find(v => v.lawId === 'three-strike-escalation');
      expect(violation).toBeUndefined();
    });
  });

  describe('checkIronLaws - no-modify-cicd', () => {
    it('blocks modifying GitHub workflows without approval', () => {
      const result = checkIronLaws({
        action: 'file_write',
        targetFile: '.github/workflows/deploy.yml',
      });
      expect(result.passed).toBe(false);
      expect(result.violations[0].lawId).toBe('no-modify-cicd');
    });

    it('allows with explicit approval', () => {
      const result = checkIronLaws({
        action: 'file_write',
        targetFile: '.github/workflows/deploy.yml',
        params: { explicitlyApproved: true },
      });
      const violation = result.violations.find(v => v.lawId === 'no-modify-cicd');
      expect(violation).toBeUndefined();
    });
  });

  describe('checkIronLaws - no-force-push', () => {
    it('blocks force push', () => {
      const result = checkIronLaws({
        action: 'git_push',
        params: { force: true },
      });
      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.lawId === 'no-force-push')).toBe(true);
    });
  });
});

describe('Error Tracking (3-Strike)', () => {
  const testKey = 'test-error-key';

  beforeEach(() => {
    clearError(testKey);
  });

  it('starts with zero errors', () => {
    expect(getErrorCount('nonexistent-key')).toBe(0);
  });

  it('records errors incrementally', () => {
    expect(recordError(testKey)).toBe(1);
    expect(recordError(testKey)).toBe(2);
    expect(recordError(testKey)).toBe(3);
  });

  it('returns correct count', () => {
    recordError(testKey);
    recordError(testKey);
    expect(getErrorCount(testKey)).toBe(2);
  });

  it('clears errors', () => {
    recordError(testKey);
    recordError(testKey);
    clearError(testKey);
    expect(getErrorCount(testKey)).toBe(0);
  });

  it('clears non-existent key without error', () => {
    expect(() => clearError('nonexistent')).not.toThrow();
  });
});
