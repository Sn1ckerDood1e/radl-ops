/**
 * Tests for issue-generator — GitHub issue creation utility
 *
 * Tests:
 * 1. formatIssueBody — template rendering with all fields
 * 2. findDuplicateIssues — fuzzy matching logic
 * 3. createDraftIssue — gh CLI integration (mocked)
 * 4. createIssuesFromBriefing — orchestration, limits, dedup
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import {
  formatIssueBody,
  findDuplicateIssues,
  createDraftIssue,
  createIssuesFromBriefing,
  type IssueInput,
} from './issue-generator.js';

function makeInput(overrides: Partial<IssueInput> = {}): IssueInput {
  return {
    title: 'Fix RLS policy for equipment',
    description: 'The RLS policy on equipment table is missing team_id check.',
    criteria: ['RLS policy updated', 'Tests pass'],
    effort: 'small',
    source: 'deferred-item (Phase 90)',
    ...overrides,
  };
}

/** Check if an execFileSync call matches a given subcommand */
function argsInclude(args: unknown[], subcommand: string): boolean {
  // args = [binary, argsArray, options]
  const cmdArgs = args[1] as string[];
  return Array.isArray(cmdArgs) && cmdArgs.some(a => a === subcommand || a.includes(subcommand));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: gh auth succeeds
  mockExecFileSync.mockImplementation((...args: unknown[]) => {
    const cmdArgs = args[1] as string[];
    if (Array.isArray(cmdArgs) && cmdArgs.includes('status')) return Buffer.from('Logged in');
    return Buffer.from('[]');
  });
});

// ─── formatIssueBody ────────────────────────────────────────────────────────

describe('formatIssueBody', () => {
  it('includes description, criteria, and metadata', () => {
    const body = formatIssueBody(makeInput());

    expect(body).toContain('## Description');
    expect(body).toContain('RLS policy on equipment table');
    expect(body).toContain('## Acceptance Criteria');
    expect(body).toContain('- [ ] RLS policy updated');
    expect(body).toContain('- [ ] Tests pass');
    expect(body).toContain('**Source:** deferred-item (Phase 90)');
    expect(body).toContain('**Estimated effort:** small');
    expect(body).toContain('radl-ops daily briefing');
    expect(body).toContain('`approved` label');
  });

  it('uses default criterion when criteria array is empty', () => {
    const body = formatIssueBody(makeInput({ criteria: [] }));

    expect(body).toContain('Implementation works as described');
  });

  it('includes current date', () => {
    const body = formatIssueBody(makeInput());
    const today = new Date().toISOString().split('T')[0];

    expect(body).toContain(today);
  });
});

// ─── findDuplicateIssues ────────────────────────────────────────────────────

describe('findDuplicateIssues', () => {
  it('returns false when no matching issues exist', () => {
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (argsInclude(args, 'list')) return Buffer.from('[]');
      return Buffer.from('');
    });

    expect(findDuplicateIssues('Fix RLS policy for equipment')).toBe(false);
  });

  it('returns true when similar issue exists (60%+ word match)', () => {
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (argsInclude(args, 'list')) {
        return Buffer.from(JSON.stringify([
          { number: 42, title: 'Fix RLS policy for equipment table' },
        ]));
      }
      return Buffer.from('');
    });

    expect(findDuplicateIssues('Fix RLS policy for equipment')).toBe(true);
  });

  it('returns false when existing issue is different enough', () => {
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (argsInclude(args, 'list')) {
        return Buffer.from(JSON.stringify([
          { number: 1, title: 'Implement attendance tracking for practices' },
        ]));
      }
      return Buffer.from('');
    });

    expect(findDuplicateIssues('Fix RLS policy for equipment')).toBe(false);
  });

  it('returns false when gh fails (allows creation)', () => {
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (argsInclude(args, 'list')) throw new Error('gh not found');
      return Buffer.from('');
    });

    expect(findDuplicateIssues('Fix RLS policy')).toBe(false);
  });

  it('returns false for empty title', () => {
    expect(findDuplicateIssues('')).toBe(false);
  });
});

// ─── createDraftIssue ───────────────────────────────────────────────────────

describe('createDraftIssue', () => {
  it('creates issue via gh CLI and returns parsed result', () => {
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (argsInclude(args, 'create')) {
        return Buffer.from(JSON.stringify({
          number: 99,
          title: 'Fix RLS policy for equipment',
          url: 'https://github.com/Sn1ckerDood1e/Radl/issues/99',
        }));
      }
      return Buffer.from('');
    });

    const result = createDraftIssue(makeInput());

    expect(result).not.toBeNull();
    expect(result!.number).toBe(99);
    expect(result!.url).toContain('issues/99');
  });

  it('returns null when gh fails', () => {
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (argsInclude(args, 'create')) throw new Error('rate limit');
      return Buffer.from('');
    });

    const result = createDraftIssue(makeInput());

    expect(result).toBeNull();
  });

  it('passes draft and watcher labels by default', () => {
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (argsInclude(args, 'create')) {
        const cmdArgs = args[1] as string[];
        expect(cmdArgs).toContain('draft');
        expect(cmdArgs).toContain('watcher');
        return Buffer.from(JSON.stringify({ number: 1, title: 'Test', url: 'url' }));
      }
      return Buffer.from('');
    });

    createDraftIssue(makeInput());
  });
});

// ─── createIssuesFromBriefing ───────────────────────────────────────────────

describe('createIssuesFromBriefing', () => {
  it('creates issues for each input item', () => {
    let createCount = 0;
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (argsInclude(args, 'status')) return Buffer.from('OK');
      if (argsInclude(args, 'list')) return Buffer.from('[]');
      if (argsInclude(args, 'create')) {
        createCount++;
        return Buffer.from(JSON.stringify({
          number: createCount,
          title: `Issue ${createCount}`,
          url: `url/${createCount}`,
        }));
      }
      return Buffer.from('');
    });

    const items = [makeInput(), makeInput({ title: 'Second item' })];
    const { created, skipped, errors } = createIssuesFromBriefing(items);

    expect(created).toHaveLength(2);
    expect(skipped).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('limits to 3 issues per briefing', () => {
    let createCount = 0;
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (argsInclude(args, 'status')) return Buffer.from('OK');
      if (argsInclude(args, 'list')) return Buffer.from('[]');
      if (argsInclude(args, 'create')) {
        createCount++;
        return Buffer.from(JSON.stringify({
          number: createCount,
          title: `Issue ${createCount}`,
          url: `url/${createCount}`,
        }));
      }
      return Buffer.from('');
    });

    const items = Array.from({ length: 5 }, (_, i) => makeInput({ title: `Item ${i}` }));
    const { created, skipped } = createIssuesFromBriefing(items);

    expect(created).toHaveLength(3);
    expect(skipped.some(s => s.includes('2 additional items'))).toBe(true);
  });

  it('skips duplicates', () => {
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      if (argsInclude(args, 'status')) return Buffer.from('OK');
      if (argsInclude(args, 'list')) {
        return Buffer.from(JSON.stringify([
          { number: 10, title: 'Fix RLS policy for equipment' },
        ]));
      }
      return Buffer.from('');
    });

    const { created, skipped } = createIssuesFromBriefing([makeInput()]);

    expect(created).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it('returns error when gh is not available', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('gh not found');
    });

    const { created, errors } = createIssuesFromBriefing([makeInput()]);

    expect(created).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('gh CLI not available');
  });
});
