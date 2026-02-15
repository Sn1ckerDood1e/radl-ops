import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  scoreAge,
  scoreEffort,
  scoreImpact,
  scoreFrequency,
  scoreBlocking,
  scoreItem,
  runPrioritization,
  formatPrioritizationOutput,
} from './prioritize.js';

vi.mock('../../config/paths.js', () => ({
  getConfig: () => ({
    radlDir: '/tmp/test-radl',
    radlOpsDir: '/tmp/test-ops',
    knowledgeDir: '/tmp/test-ops/knowledge',
    usageLogsDir: '/tmp/test-ops/usage-logs',
    sprintScript: '/tmp/test-ops/scripts/sprint.sh',
    compoundScript: '/tmp/test-ops/scripts/compound.sh',
  }),
}));

describe('scoreAge', () => {
  it('returns 0 for items created today', () => {
    const today = new Date().toISOString();
    expect(scoreAge(today)).toBe(0);
  });

  it('returns higher scores for older items', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(scoreAge(fiveDaysAgo)).toBe(10);
  });

  it('caps at 20', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(scoreAge(thirtyDaysAgo)).toBe(20);
  });
});

describe('scoreEffort', () => {
  it('scores small effort highest', () => {
    expect(scoreEffort('small')).toBe(20);
  });

  it('scores large effort lowest', () => {
    expect(scoreEffort('large')).toBe(5);
  });

  it('handles unknown effort', () => {
    expect(scoreEffort('huge')).toBe(10);
  });
});

describe('scoreImpact', () => {
  it('scores security items highest', () => {
    expect(scoreImpact('Fix CSRF token validation', 'security issue')).toBe(30);
  });

  it('scores test items high', () => {
    expect(scoreImpact('Add unit test coverage', 'testing needed')).toBe(25);
  });

  it('returns default for generic items', () => {
    expect(scoreImpact('Update README', 'needs updating')).toBe(10);
  });
});

describe('scoreFrequency', () => {
  it('returns 0 when no lessons mention the item', () => {
    const lessons = [{ text: 'unrelated lesson about deployment' }];
    expect(scoreFrequency('Fix button styling', lessons)).toBe(0);
  });

  it('returns higher score when multiple lessons mention the item', () => {
    const lessons = [
      { text: 'The button styling broke because of CSS variables' },
      { text: 'Button styling needs attention across components' },
      { text: 'Styling issues with button variants continue' },
    ];
    expect(scoreFrequency('Fix button styling issues', lessons)).toBeGreaterThan(0);
  });

  it('caps at 15', () => {
    const lessons = Array(10).fill({ text: 'button styling issues with dark mode' });
    expect(scoreFrequency('Fix button styling dark mode', lessons)).toBeLessThanOrEqual(15);
  });
});

describe('scoreBlocking', () => {
  it('returns 15 for blocking items', () => {
    expect(scoreBlocking('Foundation setup', 'blocks all other work')).toBe(15);
  });

  it('returns 10 for enabling items', () => {
    expect(scoreBlocking('Auth helper', 'needed for permission checks')).toBe(10);
  });

  it('returns 0 for non-blocking items', () => {
    expect(scoreBlocking('Fix typo', 'cosmetic issue')).toBe(0);
  });
});

describe('scoreItem', () => {
  it('produces a valid scored item', () => {
    const item = {
      id: 1,
      title: 'Fix CSRF validation',
      reason: 'Security vulnerability in auth flow',
      effort: 'small',
      sprintPhase: 'Phase 60',
      date: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      resolved: false,
    };

    const result = scoreItem(item, []);
    expect(result.id).toBe(1);
    expect(result.title).toBe('Fix CSRF validation');
    expect(result.totalScore).toBeGreaterThan(0);
    expect(result.totalScore).toBeLessThanOrEqual(100);
    expect(result.factors.age).toBeGreaterThanOrEqual(0);
    expect(result.factors.effort).toBe(20);
    expect(result.factors.impact).toBe(30); // security keyword
  });
});

describe('runPrioritization', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty result for missing knowledge dir', () => {
    const result = runPrioritization('/tmp/nonexistent', 10);
    expect(result.items).toEqual([]);
    expect(result.totalEvaluated).toBe(0);
  });
});

describe('formatPrioritizationOutput', () => {
  it('formats empty result', () => {
    const output = formatPrioritizationOutput({ items: [], totalEvaluated: 0 });
    expect(output).toContain('No unresolved items');
  });

  it('formats scored items with factor breakdown', () => {
    const result = {
      items: [{
        id: 1,
        title: 'Fix auth bug',
        source: 'Phase 60',
        totalScore: 75,
        factors: { age: 10, effort: 20, impact: 30, frequency: 5, blocking: 10 },
      }],
      totalEvaluated: 5,
    };

    const output = formatPrioritizationOutput(result);
    expect(output).toContain('Fix auth bug');
    expect(output).toContain('Score: 75/100');
    expect(output).toContain('Age: 10');
    expect(output).toContain('Evaluated 5 items');
  });
});
