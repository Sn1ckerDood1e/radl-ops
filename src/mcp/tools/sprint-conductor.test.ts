import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

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

// Module-level mock functions (same pattern as drift-detection.test.ts)
const mockGetRoute = vi.fn();
const mockCalculateCost = vi.fn();
const mockTrackUsage = vi.fn();
const mockGetAnthropicClient = vi.fn();
const mockRunEvalOptLoop = vi.fn();

vi.mock('../../models/router.js', () => ({
  getRoute: (...args: unknown[]) => mockGetRoute(...args),
  calculateCost: (...args: unknown[]) => mockCalculateCost(...args),
}));

vi.mock('../../models/token-tracker.js', () => ({
  trackUsage: (...args: unknown[]) => mockTrackUsage(...args),
}));

vi.mock('../../config/anthropic.js', () => ({
  getAnthropicClient: () => mockGetAnthropicClient(),
}));

vi.mock('../../patterns/evaluator-optimizer.js', () => ({
  runEvalOptLoop: (...args: unknown[]) => mockRunEvalOptLoop(...args),
}));

vi.mock('../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    knowledgeDir: '/tmp/test-knowledge',
    radlDir: '/tmp/test-radl',
    radlOpsDir: '/tmp/test-ops',
    usageLogsDir: '/tmp/test-logs',
    sprintScript: '/tmp/test.sh',
    compoundScript: '/tmp/test-compound.sh',
  })),
}));

// Extract handlers by registering with a mock server
async function getHandlers() {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
  };

  const { registerSprintConductorTools } = await import('./sprint-conductor.js');
  registerSprintConductorTools(mockServer as any);
  return handlers;
}

// Default mock helpers
function mockSuccessfulEvalOpt() {
  mockRunEvalOptLoop.mockResolvedValue({
    finalOutput: '# Feature Spec\n\nThis is the generated spec with acceptance criteria.',
    finalScore: 8.5,
    iterations: 2,
    totalCostUsd: 0.05,
    evaluations: [],
    converged: true,
    terminationReason: 'threshold_met',
    attempts: [],
    cacheSavingsUsd: 0,
    errors: [],
  });
}

function mockSuccessfulDecomposition() {
  const mockClient = {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{
          type: 'tool_use',
          name: 'task_decomposition',
          input: {
            tasks: [
              {
                id: 1,
                title: 'Add Prisma schema for attendance',
                description: 'Create Attendance model with check-in/out fields',
                activeForm: 'Adding attendance schema',
                type: 'migration',
                files: ['prisma/schema.prisma'],
                dependsOn: [],
                estimateMinutes: 20,
              },
              {
                id: 2,
                title: 'Create attendance API routes',
                description: 'POST /api/attendance for check-in, PATCH for check-out',
                activeForm: 'Creating attendance API',
                type: 'feature',
                files: ['src/app/api/attendance/route.ts'],
                dependsOn: [1],
                estimateMinutes: 30,
              },
              {
                id: 3,
                title: 'Add attendance UI component',
                description: 'Client component with check-in/out buttons',
                activeForm: 'Building attendance UI',
                type: 'feature',
                files: ['src/components/attendance/check-in.tsx'],
                dependsOn: [2],
                estimateMinutes: 25,
              },
            ],
            executionStrategy: 'sequential',
            rationale: 'Tasks have linear dependencies: schema -> API -> UI',
            totalEstimateMinutes: 75,
            teamRecommendation: 'Sequential execution recommended due to dependency chain',
          },
        }],
        usage: { input_tokens: 2000, output_tokens: 1000 },
      }),
    },
  };
  mockGetAnthropicClient.mockReturnValue(mockClient);
  return mockClient;
}

describe('Sprint Conductor Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    mockGetRoute.mockReturnValue({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 1024,
      inputCostPer1M: 0.80,
      outputCostPer1M: 4,
    });
    mockCalculateCost.mockReturnValue(0.005);
  });

  describe('tool registration', () => {
    it('registers the sprint_conductor tool on the server', async () => {
      const handlers = await getHandlers();
      expect(handlers['sprint_conductor']).toBeDefined();
      expect(typeof handlers['sprint_conductor']).toBe('function');
    });
  });

  describe('successful pipeline', () => {
    beforeEach(() => {
      mockSuccessfulEvalOpt();
      mockSuccessfulDecomposition();
    });

    it('returns formatted spec + task table + execution plan on success', async () => {
      const handlers = await getHandlers();
      const result = await handlers['sprint_conductor']({
        feature: 'Add practice attendance tracking with check-in/check-out times',
      });
      const text = result.content[0].text;

      // Spec section
      expect(text).toContain('## 1. Sprint Spec');
      expect(text).toContain('Quality: 8.5/10');
      expect(text).toContain('Iterations: 2');
      expect(text).toContain('Feature Spec');

      // Task table section
      expect(text).toContain('## 2. Task Breakdown');
      expect(text).toContain('Add Prisma schema for attendance');
      expect(text).toContain('Create attendance API routes');
      expect(text).toContain('Add attendance UI component');

      // Execution plan section
      expect(text).toContain('## 3. Execution Plan');
      expect(text).toContain('Wave');

      // PR template section
      expect(text).toContain('## 4. PR Template');

      // Cost footer
      expect(text).toContain('Total AI cost:');
    });

    it('passes default quality threshold of 8 when not provided', async () => {
      const handlers = await getHandlers();
      await handlers['sprint_conductor']({
        feature: 'Some feature description here',
      });

      expect(mockRunEvalOptLoop).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ qualityThreshold: 8 }),
      );
    });

    it('passes custom quality threshold when provided', async () => {
      const handlers = await getHandlers();
      await handlers['sprint_conductor']({
        feature: 'Some feature description here',
        quality_threshold: 9,
      });

      expect(mockRunEvalOptLoop).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ qualityThreshold: 9 }),
      );
    });

    it('includes context in spec prompt when provided', async () => {
      const handlers = await getHandlers();
      await handlers['sprint_conductor']({
        feature: 'Add attendance tracking',
        context: 'Use the existing Practice model as parent',
      });

      expect(mockRunEvalOptLoop).toHaveBeenCalledWith(
        expect.stringContaining('Use the existing Practice model as parent'),
        expect.any(Object),
      );
    });
  });

  describe('knowledge loading', () => {
    beforeEach(() => {
      mockSuccessfulEvalOpt();
      mockSuccessfulDecomposition();
    });

    it('loads knowledge context from patterns, lessons, deferred', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync)
        .mockReturnValueOnce(JSON.stringify({
          patterns: [
            { name: 'CSRF headers', description: 'All fetch calls must include CSRF headers' },
          ],
        }))
        .mockReturnValueOnce(JSON.stringify({
          lessons: [
            { learning: 'Always trace full data flow' },
          ],
        }))
        .mockReturnValueOnce(JSON.stringify({
          items: [
            { title: 'Fix nav bugs', effort: 'small', resolved: false },
          ],
        }))
        .mockReturnValueOnce(JSON.stringify({
          calibrationFactor: 0.5,
        }));

      const handlers = await getHandlers();
      await handlers['sprint_conductor']({
        feature: 'Add attendance tracking feature',
      });

      // Verify patterns and lessons are included in the spec prompt
      const specPrompt = mockRunEvalOptLoop.mock.calls[0][0];
      expect(specPrompt).toContain('CSRF headers');
      expect(specPrompt).toContain('Always trace full data flow');
      expect(specPrompt).toContain('Fix nav bugs');
    });

    it('falls back gracefully when knowledge files are missing', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const handlers = await getHandlers();
      const result = await handlers['sprint_conductor']({
        feature: 'Add attendance tracking feature',
      });

      // Should still succeed without knowledge
      expect(result.content[0].text).toContain('## 1. Sprint Spec');
    });

    it('handles corrupted knowledge files gracefully', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('not valid json {{{');

      const handlers = await getHandlers();
      const result = await handlers['sprint_conductor']({
        feature: 'Add attendance tracking feature',
      });

      // Should still succeed despite parse errors
      expect(result.content[0].text).toContain('## 1. Sprint Spec');
    });
  });

  describe('error handling', () => {
    it('handles eval-opt loop failure', async () => {
      mockRunEvalOptLoop.mockRejectedValue(new Error('Anthropic API timeout'));

      const handlers = await getHandlers();
      await expect(handlers['sprint_conductor']({
        feature: 'Add attendance tracking feature',
      })).rejects.toThrow('Anthropic API timeout');
    });

    it('handles decomposition failure with invalid Haiku response', async () => {
      mockSuccessfulEvalOpt();

      // Mock Haiku returning text instead of tool_use
      mockGetAnthropicClient.mockReturnValue({
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'I cannot decompose this.' }],
            usage: { input_tokens: 500, output_tokens: 200 },
          }),
        },
      });

      const handlers = await getHandlers();
      await expect(handlers['sprint_conductor']({
        feature: 'Add attendance tracking feature',
      })).rejects.toThrow('Failed to parse task decomposition');
    });

    it('handles decomposition with invalid schema from Haiku', async () => {
      mockSuccessfulEvalOpt();

      mockGetAnthropicClient.mockReturnValue({
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{
              type: 'tool_use',
              name: 'task_decomposition',
              input: {
                tasks: [{ id: 'not-a-number' }], // Invalid schema
                executionStrategy: 'invalid',
              },
            }],
            usage: { input_tokens: 500, output_tokens: 200 },
          }),
        },
      });

      const handlers = await getHandlers();
      await expect(handlers['sprint_conductor']({
        feature: 'Add attendance tracking feature',
      })).rejects.toThrow('Failed to parse task decomposition');
    });
  });

  describe('execution planning', () => {
    it('correctly groups tasks into parallel waves', async () => {
      const { groupIntoWaves } = await import('./sprint-conductor.js');

      const tasks = [
        { id: 1, title: 'Schema', description: '', activeForm: '', type: 'migration' as const, files: ['schema.prisma'], dependsOn: [], estimateMinutes: 20 },
        { id: 2, title: 'API A', description: '', activeForm: '', type: 'feature' as const, files: ['api-a.ts'], dependsOn: [1], estimateMinutes: 30 },
        { id: 3, title: 'API B', description: '', activeForm: '', type: 'feature' as const, files: ['api-b.ts'], dependsOn: [1], estimateMinutes: 25 },
        { id: 4, title: 'UI', description: '', activeForm: '', type: 'feature' as const, files: ['ui.tsx'], dependsOn: [2, 3], estimateMinutes: 20 },
      ];

      const waves = groupIntoWaves(tasks);

      // Wave 1: task 1 (no deps)
      expect(waves[0].tasks.map(t => t.id)).toEqual([1]);
      // Wave 2: tasks 2, 3 (both depend on 1)
      expect(waves[1].tasks.map(t => t.id)).toEqual([2, 3]);
      // Wave 3: task 4 (depends on 2 and 3)
      expect(waves[2].tasks.map(t => t.id)).toEqual([4]);
    });

    it('correctly sorts tasks topologically', async () => {
      const { topologicalSort } = await import('./sprint-conductor.js');

      const tasks = [
        { id: 3, title: 'UI', description: '', activeForm: '', type: 'feature' as const, files: [], dependsOn: [1, 2], estimateMinutes: 10 },
        { id: 1, title: 'Schema', description: '', activeForm: '', type: 'migration' as const, files: [], dependsOn: [], estimateMinutes: 10 },
        { id: 2, title: 'API', description: '', activeForm: '', type: 'feature' as const, files: [], dependsOn: [1], estimateMinutes: 10 },
      ];

      const sorted = topologicalSort(tasks);
      const ids = sorted.map(t => t.id);

      // Schema (1) must come before API (2) and UI (3)
      expect(ids.indexOf(1)).toBeLessThan(ids.indexOf(2));
      expect(ids.indexOf(1)).toBeLessThan(ids.indexOf(3));
      // API (2) must come before UI (3)
      expect(ids.indexOf(2)).toBeLessThan(ids.indexOf(3));
    });

    it('detects file conflicts between parallel tasks', async () => {
      const { detectFileConflicts } = await import('./sprint-conductor.js');

      const tasks = [
        { id: 1, title: 'Task A', description: '', activeForm: '', type: 'feature' as const, files: ['shared.ts', 'a.ts'], dependsOn: [], estimateMinutes: 10 },
        { id: 2, title: 'Task B', description: '', activeForm: '', type: 'feature' as const, files: ['shared.ts', 'b.ts'], dependsOn: [], estimateMinutes: 10 },
        { id: 3, title: 'Task C', description: '', activeForm: '', type: 'feature' as const, files: ['c.ts'], dependsOn: [], estimateMinutes: 10 },
      ];

      const conflicts = detectFileConflicts(tasks);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toContain('shared.ts');
      expect(conflicts[0]).toContain('1');
      expect(conflicts[0]).toContain('2');
    });

    it('marks waves with file conflicts', async () => {
      const { groupIntoWaves } = await import('./sprint-conductor.js');

      const tasks = [
        { id: 1, title: 'Task A', description: '', activeForm: '', type: 'feature' as const, files: ['shared.ts'], dependsOn: [], estimateMinutes: 10 },
        { id: 2, title: 'Task B', description: '', activeForm: '', type: 'feature' as const, files: ['shared.ts'], dependsOn: [], estimateMinutes: 10 },
      ];

      const waves = groupIntoWaves(tasks);
      expect(waves[0].hasConflicts).toBe(true);
      expect(waves[0].fileConflicts).toHaveLength(1);
    });

    it('applies estimation calibration factor', async () => {
      const { buildExecutionPlan, ESTIMATION_CALIBRATION_FACTOR } = await import('./sprint-conductor.js');

      const decomposition = {
        tasks: [
          { id: 1, title: 'Task A', description: '', activeForm: '', type: 'feature' as const, files: ['a.ts'], dependsOn: [], estimateMinutes: 60 },
          { id: 2, title: 'Task B', description: '', activeForm: '', type: 'feature' as const, files: ['b.ts'], dependsOn: [], estimateMinutes: 40 },
        ],
        executionStrategy: 'parallel' as const,
        rationale: 'Independent tasks',
        totalEstimateMinutes: 100,
        teamRecommendation: 'None',
      };

      const plan = buildExecutionPlan(decomposition);

      expect(plan.totalEstimateMinutes).toBe(100); // 60 + 40
      expect(plan.calibratedEstimateMinutes).toBe(Math.round(100 * ESTIMATION_CALIBRATION_FACTOR));
    });

    it('recommends team when wave has 3+ tasks', async () => {
      const { buildExecutionPlan } = await import('./sprint-conductor.js');

      const decomposition = {
        tasks: [
          { id: 1, title: 'A', description: '', activeForm: '', type: 'feature' as const, files: ['a.ts'], dependsOn: [], estimateMinutes: 20 },
          { id: 2, title: 'B', description: '', activeForm: '', type: 'feature' as const, files: ['b.ts'], dependsOn: [], estimateMinutes: 20 },
          { id: 3, title: 'C', description: '', activeForm: '', type: 'feature' as const, files: ['c.ts'], dependsOn: [], estimateMinutes: 20 },
        ],
        executionStrategy: 'parallel' as const,
        rationale: 'All independent',
        totalEstimateMinutes: 60,
        teamRecommendation: 'Use team',
      };

      const plan = buildExecutionPlan(decomposition);
      expect(plan.recommendTeam).toBe(true);
    });

    it('does not recommend team when waves are small', async () => {
      const { buildExecutionPlan } = await import('./sprint-conductor.js');

      const decomposition = {
        tasks: [
          { id: 1, title: 'A', description: '', activeForm: '', type: 'feature' as const, files: ['a.ts'], dependsOn: [], estimateMinutes: 20 },
          { id: 2, title: 'B', description: '', activeForm: '', type: 'feature' as const, files: ['b.ts'], dependsOn: [1], estimateMinutes: 20 },
        ],
        executionStrategy: 'sequential' as const,
        rationale: 'Linear dependency',
        totalEstimateMinutes: 40,
        teamRecommendation: 'None',
      };

      const plan = buildExecutionPlan(decomposition);
      expect(plan.recommendTeam).toBe(false);
    });

    it('determines correct strategy based on wave structure', async () => {
      const { buildExecutionPlan } = await import('./sprint-conductor.js');

      // All sequential
      const seqDecomp = {
        tasks: [
          { id: 1, title: 'A', description: '', activeForm: '', type: 'feature' as const, files: ['a.ts'], dependsOn: [], estimateMinutes: 20 },
          { id: 2, title: 'B', description: '', activeForm: '', type: 'feature' as const, files: ['b.ts'], dependsOn: [1], estimateMinutes: 20 },
        ],
        executionStrategy: 'sequential' as const,
        rationale: '',
        totalEstimateMinutes: 40,
        teamRecommendation: '',
      };
      expect(buildExecutionPlan(seqDecomp).strategy).toBe('sequential');

      // All parallel
      const parDecomp = {
        tasks: [
          { id: 1, title: 'A', description: '', activeForm: '', type: 'feature' as const, files: ['a.ts'], dependsOn: [], estimateMinutes: 20 },
          { id: 2, title: 'B', description: '', activeForm: '', type: 'feature' as const, files: ['b.ts'], dependsOn: [], estimateMinutes: 20 },
        ],
        executionStrategy: 'parallel' as const,
        rationale: '',
        totalEstimateMinutes: 40,
        teamRecommendation: '',
      };
      expect(buildExecutionPlan(parDecomp).strategy).toBe('parallel');

      // Mixed
      const mixDecomp = {
        tasks: [
          { id: 1, title: 'A', description: '', activeForm: '', type: 'feature' as const, files: ['a.ts'], dependsOn: [], estimateMinutes: 20 },
          { id: 2, title: 'B', description: '', activeForm: '', type: 'feature' as const, files: ['b.ts'], dependsOn: [], estimateMinutes: 20 },
          { id: 3, title: 'C', description: '', activeForm: '', type: 'feature' as const, files: ['c.ts'], dependsOn: [1, 2], estimateMinutes: 20 },
        ],
        executionStrategy: 'mixed' as const,
        rationale: '',
        totalEstimateMinutes: 60,
        teamRecommendation: '',
      };
      expect(buildExecutionPlan(mixDecomp).strategy).toBe('mixed');
    });
  });

  describe('output formatting', () => {
    it('includes team commands for waves with 3+ tasks', async () => {
      mockSuccessfulEvalOpt();

      mockGetAnthropicClient.mockReturnValue({
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{
              type: 'tool_use',
              name: 'task_decomposition',
              input: {
                tasks: [
                  { id: 1, title: 'API A', description: 'Desc', activeForm: 'Building A', type: 'feature', files: ['a.ts'], dependsOn: [], estimateMinutes: 20 },
                  { id: 2, title: 'API B', description: 'Desc', activeForm: 'Building B', type: 'feature', files: ['b.ts'], dependsOn: [], estimateMinutes: 20 },
                  { id: 3, title: 'API C', description: 'Desc', activeForm: 'Building C', type: 'feature', files: ['c.ts'], dependsOn: [], estimateMinutes: 20 },
                ],
                executionStrategy: 'parallel',
                rationale: 'All independent APIs',
                totalEstimateMinutes: 60,
                teamRecommendation: 'Use agent team',
              },
            }],
            usage: { input_tokens: 2000, output_tokens: 1000 },
          }),
        },
      });

      const handlers = await getHandlers();
      const result = await handlers['sprint_conductor']({
        feature: 'Add three independent API endpoints',
      });
      const text = result.content[0].text;

      expect(text).toContain('Team command:');
      expect(text).toContain('subagent_type="coder"');
      expect(text).toContain('run_in_background=true');
    });

    it('generates PR template from task titles', async () => {
      mockSuccessfulEvalOpt();
      mockSuccessfulDecomposition();

      const handlers = await getHandlers();
      const result = await handlers['sprint_conductor']({
        feature: 'Add practice attendance tracking',
      });
      const text = result.content[0].text;

      expect(text).toContain('## 4. PR Template');
      expect(text).toContain('feat:');
      expect(text).toContain('- [x] Add Prisma schema for attendance');
      expect(text).toContain('- [x] Create attendance API routes');
      expect(text).toContain('- [x] Add attendance UI component');
    });
  });

  describe('cost tracking', () => {
    it('tracks decomposition usage with sprint-conductor-decompose tag', async () => {
      mockSuccessfulEvalOpt();
      mockSuccessfulDecomposition();

      const handlers = await getHandlers();
      await handlers['sprint_conductor']({
        feature: 'Add attendance tracking feature',
      });

      expect(mockTrackUsage).toHaveBeenCalledWith(
        'claude-haiku-4-5-20251001',
        2000,
        1000,
        'planning',
        'sprint-conductor-decompose',
      );
    });

    it('uses spot_check route for decomposition (Haiku)', async () => {
      mockSuccessfulEvalOpt();
      mockSuccessfulDecomposition();

      const handlers = await getHandlers();
      await handlers['sprint_conductor']({
        feature: 'Add attendance tracking feature',
      });

      expect(mockGetRoute).toHaveBeenCalledWith('spot_check');
    });

    it('includes eval-opt cost in total', async () => {
      mockRunEvalOptLoop.mockResolvedValue({
        finalOutput: '# Spec',
        finalScore: 9,
        iterations: 1,
        totalCostUsd: 0.123,
        evaluations: [],
        converged: true,
        terminationReason: 'threshold_met',
        attempts: [],
        cacheSavingsUsd: 0,
        errors: [],
      });
      mockSuccessfulDecomposition();
      mockCalculateCost.mockReturnValue(0.005);

      const handlers = await getHandlers();
      const result = await handlers['sprint_conductor']({
        feature: 'Add attendance tracking feature',
      });
      const text = result.content[0].text;

      // Total should be eval-opt cost (0.123) + decompose cost (0.005) = 0.128
      expect(text).toContain('$0.128');
    });
  });

  describe('sanitizeForPrompt', () => {
    it('escapes angle brackets and backticks', async () => {
      const { sanitizeForPrompt } = await import('./sprint-conductor.js');

      expect(sanitizeForPrompt('<script>alert("xss")</script>')).toBe(
        '&lt;script&gt;alert("xss")&lt;/script&gt;'
      );
      expect(sanitizeForPrompt('use `getUser()` always')).toBe(
        "use 'getUser()' always"
      );
    });

    it('replaces newlines with spaces', async () => {
      const { sanitizeForPrompt } = await import('./sprint-conductor.js');
      expect(sanitizeForPrompt('line1\nline2\nline3')).toBe('line1 line2 line3');
    });
  });

  describe('validateTaskFileCounts', () => {
    it('detects tasks exceeding file limit', async () => {
      const { validateTaskFileCounts } = await import('./sprint-conductor.js');
      const decomposition = {
        tasks: [{
          id: 1, title: 'Big task', description: '', activeForm: '', type: 'feature' as const,
          files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
          dependsOn: [], estimateMinutes: 30,
        }, {
          id: 2, title: 'Small task', description: '', activeForm: '', type: 'feature' as const,
          files: ['g.ts'], dependsOn: [], estimateMinutes: 10,
        }],
        executionStrategy: 'sequential' as const,
        rationale: '', totalEstimateMinutes: 40, teamRecommendation: '',
      };

      const violations = validateTaskFileCounts(decomposition, 5);
      expect(violations).toHaveLength(1);
      expect(violations[0].taskId).toBe(1);
      expect(violations[0].fileCount).toBe(6);
    });

    it('returns empty for valid tasks', async () => {
      const { validateTaskFileCounts } = await import('./sprint-conductor.js');
      const decomposition = {
        tasks: [{
          id: 1, title: 'Ok task', description: '', activeForm: '', type: 'feature' as const,
          files: ['a.ts', 'b.ts'], dependsOn: [], estimateMinutes: 20,
        }],
        executionStrategy: 'sequential' as const,
        rationale: '', totalEstimateMinutes: 20, teamRecommendation: '',
      };

      expect(validateTaskFileCounts(decomposition)).toHaveLength(0);
    });
  });

  describe('autoSplitOversizedTasks', () => {
    it('splits oversized tasks into sub-tasks', async () => {
      const { autoSplitOversizedTasks } = await import('./sprint-conductor.js');
      const decomposition = {
        tasks: [{
          id: 1, title: 'Big task', description: 'desc', activeForm: 'Working',
          type: 'feature' as const,
          files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts'],
          dependsOn: [], estimateMinutes: 60,
        }],
        executionStrategy: 'sequential' as const,
        rationale: '', totalEstimateMinutes: 60, teamRecommendation: '',
      };

      const result = autoSplitOversizedTasks(decomposition, 5);
      expect(result.tasks.length).toBe(2); // ceil(8/4) = 2 chunks
      expect(result.tasks[0].files).toHaveLength(4);
      expect(result.tasks[1].files).toHaveLength(4);
    });

    it('preserves dependency chain between sub-tasks', async () => {
      const { autoSplitOversizedTasks } = await import('./sprint-conductor.js');
      const decomposition = {
        tasks: [{
          id: 1, title: 'Big task', description: 'desc', activeForm: 'Working',
          type: 'feature' as const,
          files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts'],
          dependsOn: [], estimateMinutes: 60,
        }],
        executionStrategy: 'sequential' as const,
        rationale: '', totalEstimateMinutes: 60, teamRecommendation: '',
      };

      const result = autoSplitOversizedTasks(decomposition, 5);
      // Second sub-task should depend on first
      expect(result.tasks[1].dependsOn).toContain(result.tasks[0].id);
    });

    it('no-op when all tasks are valid', async () => {
      const { autoSplitOversizedTasks } = await import('./sprint-conductor.js');
      const decomposition = {
        tasks: [{
          id: 1, title: 'Small', description: '', activeForm: '', type: 'feature' as const,
          files: ['a.ts', 'b.ts'], dependsOn: [], estimateMinutes: 15,
        }],
        executionStrategy: 'sequential' as const,
        rationale: '', totalEstimateMinutes: 15, teamRecommendation: '',
      };

      const result = autoSplitOversizedTasks(decomposition, 5);
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].title).toBe('Small');
    });
  });

  describe('checkDataFlowCoverage', () => {
    it('flags schema tasks without API handlers', async () => {
      const { checkDataFlowCoverage } = await import('./sprint-conductor.js');
      const decomposition = {
        tasks: [{
          id: 1, title: 'Add migration', description: '', activeForm: '',
          type: 'migration' as const,
          files: ['prisma/schema.prisma', 'prisma/migrations/001.sql'],
          dependsOn: [], estimateMinutes: 15,
        }, {
          id: 2, title: 'Add UI', description: '', activeForm: '',
          type: 'feature' as const,
          files: ['src/components/form.tsx'],
          dependsOn: [1], estimateMinutes: 30,
        }],
        executionStrategy: 'mixed' as const,
        rationale: '', totalEstimateMinutes: 45, teamRecommendation: '',
      };

      const warnings = checkDataFlowCoverage(decomposition);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('API route handler');
    });

    it('no warnings when API handler exists', async () => {
      const { checkDataFlowCoverage } = await import('./sprint-conductor.js');
      const decomposition = {
        tasks: [{
          id: 1, title: 'Migration', description: '', activeForm: '',
          type: 'migration' as const,
          files: ['prisma/schema.prisma'],
          dependsOn: [], estimateMinutes: 15,
        }, {
          id: 2, title: 'API', description: '', activeForm: '',
          type: 'feature' as const,
          files: ['src/app/api/things/route.ts'],
          dependsOn: [1], estimateMinutes: 20,
        }],
        executionStrategy: 'sequential' as const,
        rationale: '', totalEstimateMinutes: 35, teamRecommendation: '',
      };

      expect(checkDataFlowCoverage(decomposition)).toHaveLength(0);
    });
  });

  describe('checkTestCoverage', () => {
    it('warns when no test tasks exist', async () => {
      const { checkTestCoverage } = await import('./sprint-conductor.js');
      const decomposition = {
        tasks: [{
          id: 1, title: 'Feature', description: '', activeForm: '',
          type: 'feature' as const, files: ['a.ts'], dependsOn: [], estimateMinutes: 30,
        }],
        executionStrategy: 'sequential' as const,
        rationale: '', totalEstimateMinutes: 30, teamRecommendation: '',
      };

      expect(checkTestCoverage(decomposition)).toContain('WARNING');
    });

    it('returns null when test task exists', async () => {
      const { checkTestCoverage } = await import('./sprint-conductor.js');
      const decomposition = {
        tasks: [{
          id: 1, title: 'Feature', description: '', activeForm: '',
          type: 'feature' as const, files: ['a.ts'], dependsOn: [], estimateMinutes: 30,
        }, {
          id: 2, title: 'Tests', description: '', activeForm: '',
          type: 'test' as const, files: ['a.test.ts'], dependsOn: [1], estimateMinutes: 20,
        }],
        executionStrategy: 'sequential' as const,
        rationale: '', totalEstimateMinutes: 50, teamRecommendation: '',
      };

      expect(checkTestCoverage(decomposition)).toBeNull();
    });
  });

  describe('buildExecutionPlan review checkpoints', () => {
    it('inserts review checkpoints after multi-task waves', async () => {
      const { buildExecutionPlan } = await import('./sprint-conductor.js');
      const decomposition = {
        tasks: [
          { id: 1, title: 'A', description: '', activeForm: '', type: 'feature' as const, files: ['a.ts'], dependsOn: [], estimateMinutes: 20 },
          { id: 2, title: 'B', description: '', activeForm: '', type: 'feature' as const, files: ['b.ts'], dependsOn: [], estimateMinutes: 20 },
          { id: 3, title: 'C', description: '', activeForm: '', type: 'test' as const, files: ['c.ts'], dependsOn: [1, 2], estimateMinutes: 15 },
        ],
        executionStrategy: 'mixed' as const,
        rationale: '', totalEstimateMinutes: 55, teamRecommendation: '',
      };

      const plan = buildExecutionPlan(decomposition);
      const reviewWaves = plan.waves.filter(w => w.isReviewCheckpoint);
      expect(reviewWaves.length).toBeGreaterThanOrEqual(1);
      expect(reviewWaves[0].tasks).toHaveLength(0);
    });

    it('does not insert checkpoint after single-task waves', async () => {
      const { buildExecutionPlan } = await import('./sprint-conductor.js');
      const decomposition = {
        tasks: [
          { id: 1, title: 'A', description: '', activeForm: '', type: 'feature' as const, files: ['a.ts'], dependsOn: [], estimateMinutes: 20 },
          { id: 2, title: 'B', description: '', activeForm: '', type: 'feature' as const, files: ['b.ts'], dependsOn: [1], estimateMinutes: 20 },
        ],
        executionStrategy: 'sequential' as const,
        rationale: '', totalEstimateMinutes: 40, teamRecommendation: '',
      };

      const plan = buildExecutionPlan(decomposition);
      const reviewWaves = plan.waves.filter(w => w.isReviewCheckpoint);
      expect(reviewWaves).toHaveLength(0);
    });
  });
});
