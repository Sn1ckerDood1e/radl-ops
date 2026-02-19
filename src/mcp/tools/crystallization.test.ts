import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock dependencies before imports
vi.mock('../../config/paths.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('../../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(),
}));

vi.mock('../../models/token-tracker.js', () => ({
  trackUsage: vi.fn(),
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/retry.js', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../models/router.js', () => ({
  getRoute: vi.fn(() => ({
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    maxTokens: 1024,
    inputCostPer1M: 0.80,
    outputCostPer1M: 4,
  })),
  calculateCost: vi.fn(() => 0.002),
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

import { getConfig } from '../../config/paths.js';
import { getAnthropicClient } from '../../config/anthropic.js';
import {
  matchCrystallizedChecks,
  loadCrystallized,
  saveCrystallized,
} from './crystallization.js';
import type { CrystallizedCheck } from './crystallization.js';

let tempDir: string;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'crystallization-test-'));
}

function mockConfig(knowledgeDir: string): void {
  vi.mocked(getConfig).mockReturnValue({
    radlDir: '/tmp/radl',
    radlOpsDir: '/tmp/radl-ops',
    knowledgeDir,
    usageLogsDir: '/tmp/usage-logs',
    sprintScript: '/tmp/radl-ops/scripts/sprint.sh',
    compoundScript: '/tmp/radl-ops/scripts/compound.sh',
  });
}

function createActiveCheck(overrides: Partial<CrystallizedCheck> = {}): CrystallizedCheck {
  return {
    id: 1,
    lessonIds: [1, 2],
    trigger: 'When adding new Prisma fields',
    triggerKeywords: ['prisma', 'field', 'schema', 'migration'],
    check: 'Verify field appears in API handler updateData object',
    checkType: 'manual',
    grepPattern: null,
    status: 'active',
    proposedAt: '2026-01-01T00:00:00.000Z',
    approvedAt: '2026-01-02T00:00:00.000Z',
    catches: 3,
    falsePositives: 0,
    demotedAt: null,
    demotionReason: null,
    ...overrides,
  };
}

describe('matchCrystallizedChecks', () => {
  it('returns checks with 2+ keyword overlap', () => {
    const checks: CrystallizedCheck[] = [
      createActiveCheck({
        id: 1,
        triggerKeywords: ['prisma', 'field', 'schema', 'migration'],
      }),
    ];

    const result = matchCrystallizedChecks(
      'Added a new Prisma field to the schema',
      checks,
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it('does not return checks with only 1 keyword match', () => {
    const checks: CrystallizedCheck[] = [
      createActiveCheck({
        id: 1,
        triggerKeywords: ['prisma', 'field', 'schema', 'migration'],
      }),
    ];

    const result = matchCrystallizedChecks(
      'Updated the prisma client version',
      checks,
    );

    expect(result).toHaveLength(0);
  });

  it('only matches active checks, not proposed or demoted', () => {
    const checks: CrystallizedCheck[] = [
      createActiveCheck({ id: 1, status: 'proposed', triggerKeywords: ['prisma', 'field'] }),
      createActiveCheck({ id: 2, status: 'active', triggerKeywords: ['prisma', 'field'] }),
      createActiveCheck({ id: 3, status: 'demoted', triggerKeywords: ['prisma', 'field'] }),
    ];

    const result = matchCrystallizedChecks('prisma field update', checks);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
  });

  it('returns empty array when no checks match', () => {
    const checks: CrystallizedCheck[] = [
      createActiveCheck({ triggerKeywords: ['prisma', 'field', 'schema'] }),
    ];

    const result = matchCrystallizedChecks('fixed a CSS styling bug', checks);

    expect(result).toHaveLength(0);
  });

  it('is case insensitive', () => {
    const checks: CrystallizedCheck[] = [
      createActiveCheck({ triggerKeywords: ['prisma', 'field'] }),
    ];

    const result = matchCrystallizedChecks('Updated PRISMA FIELD definitions', checks);

    expect(result).toHaveLength(1);
  });

  it('returns multiple matching checks', () => {
    const checks: CrystallizedCheck[] = [
      createActiveCheck({ id: 1, triggerKeywords: ['api', 'handler', 'route'] }),
      createActiveCheck({ id: 2, triggerKeywords: ['api', 'validation', 'zod'] }),
      createActiveCheck({ id: 3, triggerKeywords: ['database', 'index'] }),
    ];

    const result = matchCrystallizedChecks(
      'Added new API handler with Zod validation for the route',
      checks,
    );

    expect(result).toHaveLength(2);
    expect(result.map(c => c.id)).toEqual(expect.arrayContaining([1, 2]));
  });

  it('handles empty checks array', () => {
    const result = matchCrystallizedChecks('some text', []);
    expect(result).toHaveLength(0);
  });

  it('handles empty text', () => {
    const checks: CrystallizedCheck[] = [
      createActiveCheck({ triggerKeywords: ['prisma', 'field'] }),
    ];

    const result = matchCrystallizedChecks('', checks);
    expect(result).toHaveLength(0);
  });
});

describe('loadCrystallized / saveCrystallized', () => {
  beforeEach(() => {
    tempDir = makeTempDir();
    mockConfig(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty checks when file does not exist', () => {
    const result = loadCrystallized();
    expect(result).toEqual({ checks: [] });
  });

  it('round-trips data through save and load', () => {
    const data = {
      checks: [
        createActiveCheck({ id: 1 }),
        createActiveCheck({ id: 2, status: 'proposed', approvedAt: null }),
      ],
    };

    saveCrystallized(data);
    const loaded = loadCrystallized();

    expect(loaded.checks).toHaveLength(2);
    expect(loaded.checks[0].id).toBe(1);
    expect(loaded.checks[0].status).toBe('active');
    expect(loaded.checks[1].id).toBe(2);
    expect(loaded.checks[1].status).toBe('proposed');
  });

  it('preserves all fields through round-trip', () => {
    const check = createActiveCheck({
      id: 42,
      lessonIds: [10, 20, 30],
      trigger: 'When modifying auth logic',
      triggerKeywords: ['auth', 'permission', 'role', 'casl'],
      check: 'Verify CASL ability conditions',
      checkType: 'grep',
      grepPattern: 'can\\(.*Subject.*\\{',
      catches: 5,
      falsePositives: 1,
    });

    saveCrystallized({ checks: [check] });
    const loaded = loadCrystallized();

    expect(loaded.checks[0]).toEqual(check);
  });

  it('handles corrupt JSON gracefully', () => {
    const filePath = join(tempDir, 'crystallized.json');
    writeFileSync(filePath, 'not valid json{{{');

    const result = loadCrystallized();
    expect(result).toEqual({ checks: [] });
  });
});

describe('crystallize_approve logic', () => {
  beforeEach(() => {
    tempDir = makeTempDir();
    mockConfig(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('sets status to active and approvedAt when approved', () => {
    const check = createActiveCheck({
      id: 1,
      status: 'proposed',
      approvedAt: null,
    });

    saveCrystallized({ checks: [check] });

    // Simulate approve logic
    const crystallized = loadCrystallized();
    const target = crystallized.checks.find(c => c.id === 1);
    expect(target).toBeDefined();

    const now = new Date().toISOString();
    const approved: CrystallizedCheck = {
      ...target!,
      status: 'active',
      approvedAt: now,
    };

    const updatedChecks = crystallized.checks.map(c =>
      c.id === 1 ? approved : c,
    );
    saveCrystallized({ checks: updatedChecks });

    const reloaded = loadCrystallized();
    expect(reloaded.checks[0].status).toBe('active');
    expect(reloaded.checks[0].approvedAt).toBe(now);
  });
});

describe('crystallize_demote logic', () => {
  beforeEach(() => {
    tempDir = makeTempDir();
    mockConfig(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('sets status to demoted with reason and timestamp', () => {
    const check = createActiveCheck({ id: 1 });
    saveCrystallized({ checks: [check] });

    const crystallized = loadCrystallized();
    const target = crystallized.checks.find(c => c.id === 1);
    expect(target).toBeDefined();

    const now = new Date().toISOString();
    const reason = 'Too many false positives on CSS changes';
    const demoted: CrystallizedCheck = {
      ...target!,
      status: 'demoted',
      demotedAt: now,
      demotionReason: reason,
    };

    const updatedChecks = crystallized.checks.map(c =>
      c.id === 1 ? demoted : c,
    );
    saveCrystallized({ checks: updatedChecks });

    const reloaded = loadCrystallized();
    expect(reloaded.checks[0].status).toBe('demoted');
    expect(reloaded.checks[0].demotedAt).toBe(now);
    expect(reloaded.checks[0].demotionReason).toBe(reason);
  });

  it('does not affect other checks when demoting one', () => {
    const checks = [
      createActiveCheck({ id: 1 }),
      createActiveCheck({ id: 2 }),
    ];
    saveCrystallized({ checks });

    const crystallized = loadCrystallized();
    const updatedChecks = crystallized.checks.map(c =>
      c.id === 1
        ? { ...c, status: 'demoted' as const, demotedAt: new Date().toISOString(), demotionReason: 'test' }
        : c,
    );
    saveCrystallized({ checks: updatedChecks });

    const reloaded = loadCrystallized();
    expect(reloaded.checks[0].status).toBe('demoted');
    expect(reloaded.checks[1].status).toBe('active');
  });
});

describe('crystallize_propose filtering', () => {
  beforeEach(() => {
    tempDir = makeTempDir();
    mockConfig(tempDir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('filters lessons by frequency >= min_frequency', async () => {
    const lessonsData = {
      lessons: [
        { id: 1, situation: '[lesson] Phase 1', learning: 'Always check auth', date: '2026-01-01', frequency: 5, lastSeenAt: '2026-01-10' },
        { id: 2, situation: '[lesson] Phase 2', learning: 'Validate inputs', date: '2026-01-02', frequency: 1, lastSeenAt: '2026-01-05' },
        { id: 3, situation: '[lesson] Phase 3', learning: 'Trace data flow', date: '2026-01-03', frequency: 3, lastSeenAt: '2026-01-08' },
        { id: 4, situation: '[lesson] Phase 4', learning: 'Test edge cases', date: '2026-01-04' },
      ],
    };

    writeFileSync(join(tempDir, 'lessons.json'), JSON.stringify(lessonsData, null, 2));

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{
        type: 'tool_use',
        id: 'toolu_test',
        name: 'crystallize_proposals',
        input: {
          proposals: [
            {
              lessonIds: [1, 3],
              trigger: 'When modifying auth or data flow',
              triggerKeywords: ['auth', 'data', 'flow', 'check'],
              check: 'Verify auth middleware and data flow tracing',
              checkType: 'manual',
              grepPattern: null,
            },
          ],
        },
      }],
      usage: { input_tokens: 300, output_tokens: 150 },
    });

    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: mockCreate },
    } as unknown as ReturnType<typeof getAnthropicClient>);

    // Import the registration function and set up mock server
    const { createMockServer } = await import('../test-utils.js');
    const { server, handlers } = createMockServer();

    const { registerCrystallizationTools } = await import('./crystallization.js');
    registerCrystallizationTools(server as never);

    const result = await handlers['crystallize_propose']({ min_frequency: 3 });

    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Verify the AI was called with only lessons having frequency >= 3
    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content as string;
    expect(userMessage).toContain('[ID 1]');
    expect(userMessage).toContain('[ID 3]');
    expect(userMessage).not.toContain('[ID 2]');
    expect(userMessage).not.toContain('[ID 4]');

    // Verify proposals were saved
    const crystallized = loadCrystallized();
    expect(crystallized.checks).toHaveLength(1);
    expect(crystallized.checks[0].status).toBe('proposed');
    expect(crystallized.checks[0].lessonIds).toEqual([1, 3]);

    // Verify output text
    const text = result.content[0].text;
    expect(text).toContain('Crystallization Proposals');
    expect(text).toContain('Checks proposed:** 1');
  });

  it('returns early when no lessons meet frequency threshold', async () => {
    const lessonsData = {
      lessons: [
        { id: 1, situation: '[lesson] Phase 1', learning: 'Low freq lesson', date: '2026-01-01', frequency: 1 },
        { id: 2, situation: '[lesson] Phase 2', learning: 'Another low freq', date: '2026-01-02' },
      ],
    };

    writeFileSync(join(tempDir, 'lessons.json'), JSON.stringify(lessonsData, null, 2));

    const { createMockServer } = await import('../test-utils.js');
    const { server, handlers } = createMockServer();

    const { registerCrystallizationTools } = await import('./crystallization.js');
    registerCrystallizationTools(server as never);

    const result = await handlers['crystallize_propose']({ min_frequency: 3 });

    expect(result.content[0].text).toContain('No lessons found with frequency >= 3');
    expect(vi.mocked(getAnthropicClient)).not.toHaveBeenCalled();
  });

  it('treats missing frequency field as 1', async () => {
    const lessonsData = {
      lessons: [
        { id: 1, situation: '[lesson] Phase 1', learning: 'No frequency field', date: '2026-01-01' },
      ],
    };

    writeFileSync(join(tempDir, 'lessons.json'), JSON.stringify(lessonsData, null, 2));

    const { createMockServer } = await import('../test-utils.js');
    const { server, handlers } = createMockServer();

    const { registerCrystallizationTools } = await import('./crystallization.js');
    registerCrystallizationTools(server as never);

    const result = await handlers['crystallize_propose']({ min_frequency: 2 });

    expect(result.content[0].text).toContain('No lessons found with frequency >= 2');
  });
});

describe('crystallize_list', () => {
  beforeEach(() => {
    tempDir = makeTempDir();
    mockConfig(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns no-checks message when file is empty', async () => {
    const { createMockServer } = await import('../test-utils.js');
    const { server, handlers } = createMockServer();

    const { registerCrystallizationTools } = await import('./crystallization.js');
    registerCrystallizationTools(server as never);

    const result = await handlers['crystallize_list']({});
    expect(result.content[0].text).toContain('No crystallized checks found');
  });

  it('filters by status when provided', async () => {
    const checks = [
      createActiveCheck({ id: 1, status: 'active' }),
      createActiveCheck({ id: 2, status: 'proposed', approvedAt: null }),
      createActiveCheck({ id: 3, status: 'demoted', demotedAt: '2026-01-01', demotionReason: 'test' }),
    ];
    saveCrystallized({ checks });

    const { createMockServer } = await import('../test-utils.js');
    const { server, handlers } = createMockServer();

    const { registerCrystallizationTools } = await import('./crystallization.js');
    registerCrystallizationTools(server as never);

    const result = await handlers['crystallize_list']({ status: 'active' });
    const text = result.content[0].text;

    expect(text).toContain('ACTIVE');
    expect(text).toContain('Showing: active only');
    expect(text).not.toContain('PROPOSED');
    expect(text).not.toContain('DEMOTED');
  });

  it('shows all checks when no status filter', async () => {
    const checks = [
      createActiveCheck({ id: 1, status: 'active' }),
      createActiveCheck({ id: 2, status: 'proposed', approvedAt: null }),
    ];
    saveCrystallized({ checks });

    const { createMockServer } = await import('../test-utils.js');
    const { server, handlers } = createMockServer();

    const { registerCrystallizationTools } = await import('./crystallization.js');
    registerCrystallizationTools(server as never);

    const result = await handlers['crystallize_list']({});
    const text = result.content[0].text;

    expect(text).toContain('ACTIVE');
    expect(text).toContain('PROPOSED');
    expect(text).toContain('1 active, 1 proposed, 0 demoted');
  });
});

describe('proposeChecksFromLessons', () => {
  beforeEach(() => {
    tempDir = makeTempDir();
    mockConfig(tempDir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns 0 when no lessons exist', async () => {
    const { proposeChecksFromLessons } = await import('./crystallization.js');
    const count = await proposeChecksFromLessons(1);
    expect(count).toBe(0);
  });

  it('returns 0 when no lessons meet frequency threshold', async () => {
    writeFileSync(join(tempDir, 'lessons.json'), JSON.stringify({
      lessons: [
        { id: 1, situation: 'test', learning: 'test', date: '2026-01-01', frequency: 1 },
      ],
    }));

    const { proposeChecksFromLessons } = await import('./crystallization.js');
    const count = await proposeChecksFromLessons(3);
    expect(count).toBe(0);
  });

  it('proposes checks and saves them when qualifying lessons exist', async () => {
    writeFileSync(join(tempDir, 'lessons.json'), JSON.stringify({
      lessons: [
        { id: 1, situation: 'auth check', learning: 'Always verify auth', date: '2026-01-01', frequency: 5 },
        { id: 2, situation: 'data flow', learning: 'Trace full path', date: '2026-01-02', frequency: 3 },
      ],
    }));

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{
        type: 'tool_use',
        id: 'toolu_test',
        name: 'crystallize_proposals',
        input: {
          proposals: [{
            lessonIds: [1, 2],
            trigger: 'When modifying auth or data flow',
            triggerKeywords: ['auth', 'data', 'flow', 'check'],
            check: 'Verify auth and data flow',
            checkType: 'manual',
            grepPattern: null,
          }],
        },
      }],
      usage: { input_tokens: 200, output_tokens: 100 },
    });

    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: mockCreate },
    } as unknown as ReturnType<typeof getAnthropicClient>);

    const { proposeChecksFromLessons } = await import('./crystallization.js');
    const count = await proposeChecksFromLessons(1);
    expect(count).toBe(1);

    const { loadCrystallized: load } = await import('./crystallization.js');
    const data = load();
    expect(data.checks).toHaveLength(1);
    expect(data.checks[0].status).toBe('proposed');
    expect(data.checks[0].lessonIds).toEqual([1, 2]);
  });

  it('returns 0 when AI produces no proposals', async () => {
    writeFileSync(join(tempDir, 'lessons.json'), JSON.stringify({
      lessons: [
        { id: 1, situation: 'test', learning: 'test', date: '2026-01-01', frequency: 2 },
      ],
    }));

    const mockCreate = vi.fn().mockResolvedValue({
      content: [{
        type: 'tool_use',
        id: 'toolu_test',
        name: 'crystallize_proposals',
        input: { proposals: [] },
      }],
      usage: { input_tokens: 200, output_tokens: 50 },
    });

    vi.mocked(getAnthropicClient).mockReturnValue({
      messages: { create: mockCreate },
    } as unknown as ReturnType<typeof getAnthropicClient>);

    const { proposeChecksFromLessons } = await import('./crystallization.js');
    const count = await proposeChecksFromLessons(1);
    expect(count).toBe(0);
  });
});
