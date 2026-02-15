import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkItemReferences,
  getItemAgeDays,
  runDeferredTriage,
  formatTriageOutput,
} from './deferred-lifecycle.js';
import type { TriageResult } from './deferred-lifecycle.js';

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

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: 'ConfirmDialog unit tests',
    reason: 'No existing test patterns',
    effort: 'small',
    sprintPhase: 'Phase 68',
    date: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
    resolved: false,
    ...overrides,
  };
}

describe('getItemAgeDays', () => {
  it('calculates correct age in days', () => {
    const item = makeItem({
      date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(getItemAgeDays(item)).toBe(7);
  });

  it('returns 0 for today', () => {
    const item = makeItem({ date: new Date().toISOString() });
    expect(getItemAgeDays(item)).toBe(0);
  });
});

describe('checkItemReferences', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when references found', () => {
    vi.mocked(execFileSync).mockReturnValue('/home/hb/radl/src/components/ConfirmDialog.tsx\n');
    expect(checkItemReferences(makeItem(), '/home/hb/radl')).toBe(true);
  });

  it('returns false when no references found', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('no match');
    });
    expect(checkItemReferences(makeItem(), '/home/hb/radl')).toBe(false);
  });

  it('returns true for items with no extractable keywords', () => {
    const item = makeItem({ title: 'fix a bug in the api' }); // no PascalCase words
    expect(checkItemReferences(item, '/home/hb/radl')).toBe(true);
  });
});

describe('runDeferredTriage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty results for empty store', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = runDeferredTriage('/tmp/knowledge', '/home/hb/radl', true);
    expect(result.total).toBe(0);
    expect(result.autoResolved).toHaveLength(0);
    expect(result.escalated).toHaveLength(0);
    expect(result.actionable).toHaveLength(0);
  });

  it('auto-resolves items with no references', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      items: [makeItem({ id: 1, title: 'DeletedComponent cleanup' })],
    }));
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('no match');
    });

    const result = runDeferredTriage('/tmp/knowledge', '/home/hb/radl', true);
    expect(result.autoResolved).toHaveLength(1);
    expect(writeFileSync).toHaveBeenCalled();
  });

  it('escalates items older than 5 days', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      items: [makeItem({
        id: 1,
        date: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      })],
    }));
    // References exist
    vi.mocked(execFileSync).mockReturnValue('found.ts\n');

    const result = runDeferredTriage('/tmp/knowledge', '/home/hb/radl', true);
    expect(result.escalated).toHaveLength(1);
  });

  it('surfaces small-effort actionable items', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      items: [
        makeItem({ id: 1, effort: 'small' }),
        makeItem({ id: 2, effort: 'large' }),
      ],
    }));
    vi.mocked(execFileSync).mockReturnValue('found.ts\n');

    const result = runDeferredTriage('/tmp/knowledge', '/home/hb/radl', true);
    expect(result.actionable).toHaveLength(1);
    expect(result.actionable[0].id).toBe(1);
  });

  it('skips already resolved items', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      items: [makeItem({ id: 1, resolved: true })],
    }));

    const result = runDeferredTriage('/tmp/knowledge', '/home/hb/radl', true);
    expect(result.alreadyResolved).toBe(1);
    expect(result.unresolved).toBe(0);
  });
});

describe('formatTriageOutput', () => {
  it('formats clean results', () => {
    const result: TriageResult = {
      total: 5,
      unresolved: 3,
      autoResolved: [],
      escalated: [],
      actionable: [],
      alreadyResolved: 2,
    };

    const output = formatTriageOutput(result);
    expect(output).toContain('5 items');
    expect(output).toContain('2 previously resolved');
    expect(output).toContain('No items require attention');
  });

  it('formats auto-resolved items', () => {
    const result: TriageResult = {
      total: 3,
      unresolved: 2,
      autoResolved: [makeItem({ id: 1, title: 'Old component cleanup' })],
      escalated: [],
      actionable: [],
      alreadyResolved: 1,
    };

    const output = formatTriageOutput(result);
    expect(output).toContain('Auto-Resolved (1)');
    expect(output).toContain('Old component cleanup');
  });

  it('formats escalated items with age', () => {
    const result: TriageResult = {
      total: 2,
      unresolved: 2,
      autoResolved: [],
      escalated: [makeItem({
        id: 1,
        date: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      })],
      actionable: [],
      alreadyResolved: 0,
    };

    const output = formatTriageOutput(result);
    expect(output).toContain('Escalated');
    expect(output).toContain('10 days old');
  });
});
