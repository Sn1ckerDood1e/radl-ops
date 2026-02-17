import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================
// Mocks
// ============================================

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

const mockLoadAntibodies = vi.fn();
const mockMatchAntibodies = vi.fn();
const mockSaveAntibodies = vi.fn();
vi.mock('./immune-system.js', () => ({
  loadAntibodies: mockLoadAntibodies,
  matchAntibodies: mockMatchAntibodies,
  saveAntibodies: mockSaveAntibodies,
}));

const mockLoadCrystallized = vi.fn();
const mockMatchCrystallizedChecks = vi.fn();
const mockSaveCrystallized = vi.fn();
vi.mock('./crystallization.js', () => ({
  loadCrystallized: mockLoadCrystallized,
  matchCrystallizedChecks: mockMatchCrystallizedChecks,
  saveCrystallized: mockSaveCrystallized,
}));

const mockLoadCausalGraph = vi.fn();
const mockFindRelevantCauses = vi.fn();
vi.mock('./causal-graph.js', () => ({
  loadCausalGraph: mockLoadCausalGraph,
  findRelevantCauses: mockFindRelevantCauses,
}));

// Mock sprint-genome as unavailable by default
vi.mock('./shared/sprint-genome.js', () => {
  throw new Error('Module not found');
});

// ============================================
// Helpers
// ============================================

function createMockServer() {
  const handlers: Record<string, Function> = {};
  const server = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
  };
  return { server, handlers };
}

function setEmptyKnowledge(): void {
  mockLoadAntibodies.mockReturnValue({ antibodies: [] });
  mockMatchAntibodies.mockReturnValue([]);
  mockLoadCrystallized.mockReturnValue({ checks: [] });
  mockMatchCrystallizedChecks.mockReturnValue([]);
  mockLoadCausalGraph.mockReturnValue({ nodes: [], edges: [] });
  mockFindRelevantCauses.mockReturnValue({ nodes: [], edges: [], chains: [] });
}

// ============================================
// Tests
// ============================================

describe('Speculative Validate — runSpeculativeValidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEmptyKnowledge();
  });

  it('returns clean report for empty tasks', async () => {
    const { runSpeculativeValidation } = await import('./speculative-validate.js');

    const report = await runSpeculativeValidation([]);

    expect(report.taskCount).toBe(0);
    expect(report.issues).toHaveLength(0);
    expect(report.riskScore).toBe(0);
    expect(report.checksRun).toHaveLength(5);
    expect(report.summary).toContain('passed');
  });

  it('returns clean report when tasks have complete data flow', async () => {
    const { runSpeculativeValidation } = await import('./speculative-validate.js');

    const report = await runSpeculativeValidation([
      {
        title: 'Add status field',
        description: 'Add status to athlete model',
        files: [
          'prisma/schema.prisma',
          'supabase/migrations/00005_add_status.sql',
          'src/lib/validations/athlete.ts',
          'src/app/api/athletes/route.ts',
          'src/components/athletes/athlete-form.tsx',
        ],
      },
    ]);

    // No data flow gaps since all layers are present
    const dataFlowIssues = report.issues.filter(i => i.check === 'data-flow-coverage');
    expect(dataFlowIssues).toHaveLength(0);
  });

  it('flags tasks with Prisma changes but no migration', async () => {
    const { runSpeculativeValidation } = await import('./speculative-validate.js');

    const report = await runSpeculativeValidation([
      {
        title: 'Add new field to schema',
        description: 'Add field to Prisma schema',
        files: [
          'prisma/schema.prisma',
          'src/lib/validations/athlete.ts',
          'src/app/api/athletes/route.ts',
          'src/components/athletes/athlete-form.tsx',
        ],
      },
    ]);

    const dataFlowIssues = report.issues.filter(i => i.check === 'data-flow-coverage');
    expect(dataFlowIssues).toHaveLength(1);
    expect(dataFlowIssues[0].message).toContain('migration');
    expect(dataFlowIssues[0].severity).toBe('high');
    expect(report.riskScore).toBeGreaterThan(0);
  });

  it('flags multiple missing layers as critical', async () => {
    const { runSpeculativeValidation } = await import('./speculative-validate.js');

    const report = await runSpeculativeValidation([
      {
        title: 'Modify schema only',
        description: 'Update Prisma schema',
        files: ['prisma/schema.prisma'],
      },
    ]);

    const dataFlowIssues = report.issues.filter(i => i.check === 'data-flow-coverage');
    expect(dataFlowIssues).toHaveLength(1);
    expect(dataFlowIssues[0].severity).toBe('critical');
    expect(dataFlowIssues[0].message).toContain('migration');
    expect(dataFlowIssues[0].message).toContain('validation');
    expect(dataFlowIssues[0].message).toContain('api-handler');
    expect(dataFlowIssues[0].message).toContain('client-component');
  });

  it('includes antibody matches in report', async () => {
    const fakeAntibody = {
      id: 1,
      trigger: 'Missing API handler update for new field',
      triggerKeywords: ['prisma', 'field', 'handler'],
      check: 'Verify API handler processes the new field',
      checkType: 'manual' as const,
      checkPattern: null,
      origin: { sprint: 'Phase 69', bug: 'Silent data loss' },
      catches: 2,
      falsePositives: 0,
      falsePositiveRate: 0,
      active: true,
      createdAt: '2026-02-15T00:00:00.000Z',
    };

    mockLoadAntibodies.mockReturnValue({ antibodies: [fakeAntibody] });
    mockMatchAntibodies.mockReturnValue([fakeAntibody]);

    const { runSpeculativeValidation } = await import('./speculative-validate.js');

    const report = await runSpeculativeValidation([
      {
        title: 'Add prisma field and handler',
        description: 'Update the schema with new fields',
      },
    ]);

    const antibodyIssues = report.issues.filter(i => i.check === 'antibody-match');
    expect(antibodyIssues).toHaveLength(1);
    expect(antibodyIssues[0].severity).toBe('high');
    expect(antibodyIssues[0].message).toContain('Antibody #1');
    expect(antibodyIssues[0].suggestion).toContain('Verify API handler');
  });

  it('includes crystallized check matches in report', async () => {
    const fakeCheck = {
      id: 5,
      lessonIds: [1, 2],
      trigger: 'Adding new enum values in migration',
      triggerKeywords: ['enum', 'migration', 'postgresql'],
      check: 'Split into 2 migrations: add values then use values',
      checkType: 'manual' as const,
      grepPattern: null,
      status: 'active' as const,
      proposedAt: '2026-02-14T00:00:00.000Z',
      approvedAt: '2026-02-14T00:00:00.000Z',
      catches: 1,
      falsePositives: 0,
      demotedAt: null,
      demotionReason: null,
    };

    mockLoadCrystallized.mockReturnValue({ checks: [fakeCheck] });
    mockMatchCrystallizedChecks.mockReturnValue([fakeCheck]);

    const { runSpeculativeValidation } = await import('./speculative-validate.js');

    const report = await runSpeculativeValidation([
      {
        title: 'Add role enum migration',
        description: 'Add new enum values for role types',
      },
    ]);

    const crystallizedIssues = report.issues.filter(i => i.check === 'crystallized-check');
    expect(crystallizedIssues).toHaveLength(1);
    expect(crystallizedIssues[0].severity).toBe('medium');
    expect(crystallizedIssues[0].message).toContain('Crystallized Check #5');
    expect(crystallizedIssues[0].suggestion).toContain('Split into 2 migrations');
  });

  it('includes causal risks in report', async () => {
    mockLoadCausalGraph.mockReturnValue({
      nodes: [
        { id: 'd-1', type: 'decision', label: 'Used parallel agents', sprint: 'Phase 69', date: '2026-02-10' },
        { id: 'o-1', type: 'outcome', label: 'File conflicts avoided', sprint: 'Phase 69', date: '2026-02-10' },
      ],
      edges: [
        { from: 'd-1', to: 'o-1', strength: 8, evidence: 'Strict file ownership' },
      ],
    });
    mockFindRelevantCauses.mockReturnValue({
      nodes: [
        { id: 'd-1', type: 'decision', label: 'Used parallel agents', sprint: 'Phase 69', date: '2026-02-10' },
      ],
      edges: [],
      chains: ['Used parallel agents -> File conflicts avoided (evidence: Strict file ownership)'],
    });

    const { runSpeculativeValidation } = await import('./speculative-validate.js');

    const report = await runSpeculativeValidation([
      {
        title: 'Implement parallel agent workflow',
        description: 'Use parallel agents for independent tasks',
      },
    ]);

    const causalIssues = report.issues.filter(i => i.check === 'causal-risk');
    expect(causalIssues).toHaveLength(1);
    expect(causalIssues[0].severity).toBe('low');
    expect(causalIssues[0].suggestion).toContain('Causal chains');
  });

  it('calculates overall risk score from issue severities', async () => {
    // Set up antibodies to produce a high-severity issue
    const fakeAntibody = {
      id: 1,
      trigger: 'Test trigger',
      triggerKeywords: ['test', 'keyword'],
      check: 'Test check',
      checkType: 'manual' as const,
      checkPattern: null,
      origin: { sprint: 'Phase 1', bug: 'Test bug' },
      catches: 0,
      falsePositives: 0,
      falsePositiveRate: 0,
      active: true,
      createdAt: '2026-02-15T00:00:00.000Z',
    };
    mockLoadAntibodies.mockReturnValue({ antibodies: [fakeAntibody] });
    mockMatchAntibodies.mockReturnValue([fakeAntibody]);

    const { runSpeculativeValidation } = await import('./speculative-validate.js');

    const report = await runSpeculativeValidation([
      {
        title: 'Task with antibody match',
        description: 'This matches test keyword patterns',
      },
    ]);

    // high severity = 15 points
    expect(report.riskScore).toBe(15);
  });

  it('handles missing/empty knowledge gracefully', async () => {
    // Already set to empty in beforeEach via setEmptyKnowledge()
    const { runSpeculativeValidation } = await import('./speculative-validate.js');

    const report = await runSpeculativeValidation([
      {
        title: 'Normal task',
        description: 'No special patterns',
        files: ['src/components/my-component.tsx'],
      },
    ]);

    expect(report.issues).toHaveLength(0);
    expect(report.riskScore).toBe(0);
    expect(report.checksRun).toContain('genome-risk');
  });

  it('is exported and callable as a function', async () => {
    const mod = await import('./speculative-validate.js');

    expect(typeof mod.runSpeculativeValidation).toBe('function');

    const report = await mod.runSpeculativeValidation([
      { title: 'Test', description: 'Test task' },
    ]);

    expect(report).toHaveProperty('taskCount');
    expect(report).toHaveProperty('issues');
    expect(report).toHaveProperty('riskScore');
    expect(report).toHaveProperty('checksRun');
    expect(report).toHaveProperty('summary');
  });

  it('caps risk score at 100', async () => {
    // Create many antibody matches to exceed 100
    const antibodies = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      trigger: `Trigger ${i}`,
      triggerKeywords: ['test', 'keyword'],
      check: `Check ${i}`,
      checkType: 'manual' as const,
      checkPattern: null,
      origin: { sprint: 'Phase 1', bug: `Bug ${i}` },
      catches: 0,
      falsePositives: 0,
      falsePositiveRate: 0,
      active: true,
      createdAt: '2026-02-15T00:00:00.000Z',
    }));

    mockLoadAntibodies.mockReturnValue({ antibodies });
    mockMatchAntibodies.mockReturnValue(antibodies);

    const { runSpeculativeValidation } = await import('./speculative-validate.js');

    const report = await runSpeculativeValidation([
      {
        title: 'Risky task',
        description: 'Many antibody matches',
      },
    ]);

    // 10 high-severity antibodies = 10 * 15 = 150, capped at 100
    expect(report.riskScore).toBe(100);
  });

  it('does not flag tasks without Prisma files', async () => {
    const { runSpeculativeValidation } = await import('./speculative-validate.js');

    const report = await runSpeculativeValidation([
      {
        title: 'UI-only change',
        description: 'Update component styles',
        files: ['src/components/button.tsx', 'src/app/globals.css'],
      },
    ]);

    const dataFlowIssues = report.issues.filter(i => i.check === 'data-flow-coverage');
    expect(dataFlowIssues).toHaveLength(0);
  });

  it('passes title and estimate through to report', async () => {
    const { runSpeculativeValidation } = await import('./speculative-validate.js');

    const report = await runSpeculativeValidation(
      [{ title: 'Task A', description: 'Desc' }],
      { title: 'Phase 80 Sprint', estimate: '3 hours' },
    );

    expect(report.title).toBe('Phase 80 Sprint');
  });
});

describe('Speculative Validate — tool registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEmptyKnowledge();
  });

  it('registers speculative_validate tool', async () => {
    const { server, handlers } = createMockServer();

    const { registerSpeculativeValidateTools } = await import('./speculative-validate.js');
    registerSpeculativeValidateTools(server as any);

    expect(handlers['speculative_validate']).toBeDefined();
    expect(typeof handlers['speculative_validate']).toBe('function');
  });

  it('tool handler returns formatted report', async () => {
    const { server, handlers } = createMockServer();

    const { registerSpeculativeValidateTools } = await import('./speculative-validate.js');
    registerSpeculativeValidateTools(server as any);

    const result = await handlers['speculative_validate']({
      tasks: [{ title: 'Test task', description: 'A test' }],
      title: 'Test Sprint',
    });

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Speculative Validation Report');
    expect(result.content[0].text).toContain('Test Sprint');
  });
});
