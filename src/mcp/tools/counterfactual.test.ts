import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

// ============================================
// Mocks
// ============================================

const TEST_KNOWLEDGE_DIR = '/tmp/test-cf-knowledge';
const TEST_SPRINT_DIR = '/tmp/test-cf-radl/.planning/sprints';

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

vi.mock('../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    radlDir: '/tmp/test-cf-radl',
    radlOpsDir: '/tmp/test-cf-ops',
    knowledgeDir: TEST_KNOWLEDGE_DIR,
    usageLogsDir: '/tmp/test-cf-logs',
    sprintScript: '/tmp/test.sh',
    compoundScript: '/tmp/test-compound.sh',
  })),
}));

vi.mock('../../models/router.js', () => ({
  getRoute: vi.fn(() => ({
    model: 'claude-sonnet-4-5-20250929',
    effort: 'high',
    maxTokens: 4096,
    inputCostPer1M: 3,
    outputCostPer1M: 15,
  })),
  calculateCost: vi.fn(() => 0.02),
}));

vi.mock('../../models/token-tracker.js', () => ({
  trackUsage: vi.fn(),
}));

const mockCreate = vi.fn();
vi.mock('../../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(() => ({
    messages: { create: mockCreate },
  })),
}));

vi.mock('../../utils/retry.js', () => ({
  withRetry: vi.fn((fn: Function) => fn()),
}));

const mockLoadCausalGraph = vi.fn();
vi.mock('./causal-graph.js', () => ({
  loadCausalGraph: mockLoadCausalGraph,
}));

// ============================================
// Helpers
// ============================================

function ensureDirs(): void {
  const archiveDir = join(TEST_SPRINT_DIR, 'archive');
  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }
  if (!existsSync(TEST_KNOWLEDGE_DIR)) {
    mkdirSync(TEST_KNOWLEDGE_DIR, { recursive: true });
  }
}

function cleanupDirs(): void {
  if (existsSync('/tmp/test-cf-radl')) {
    rmSync('/tmp/test-cf-radl', { recursive: true });
  }
  if (existsSync(TEST_KNOWLEDGE_DIR)) {
    rmSync(TEST_KNOWLEDGE_DIR, { recursive: true });
  }
}

function writeSprint(filename: string, data: Record<string, unknown>): void {
  const archiveDir = join(TEST_SPRINT_DIR, 'archive');
  writeFileSync(join(archiveDir, filename), JSON.stringify(data));
}

function makeTextResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 500, output_tokens: 800 },
  };
}

async function getHandler() {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
  };

  const mod = await import('./counterfactual.js');
  mod.registerCounterfactualTools(mockServer as any);
  return handlers;
}

// ============================================
// Tests
// ============================================

describe('counterfactual_analyze — tool registration', () => {
  it('registers the counterfactual_analyze tool', async () => {
    const tools: string[] = [];
    const mockServer = {
      tool: (...args: unknown[]) => {
        tools.push(args[0] as string);
      },
    };

    const { registerCounterfactualTools } = await import('./counterfactual.js');
    registerCounterfactualTools(mockServer as any);

    expect(tools).toContain('counterfactual_analyze');
    expect(tools).toHaveLength(1);
  });
});

describe('counterfactual_analyze — with sprint data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupDirs();
    ensureDirs();
    mockLoadCausalGraph.mockReturnValue({ nodes: [], edges: [] });
  });

  afterEach(() => {
    cleanupDirs();
  });

  it('loads sprint data and calls Sonnet for analysis', async () => {
    writeSprint('sprint-phase69.json', {
      phase: 'Phase 69',
      title: 'Practice Builder Enhancements',
      status: 'complete',
      startedAt: '2026-02-12T10:00:00Z',
      completedAt: '2026-02-12T11:30:00Z',
      completedTasks: ['Add drag-and-drop', 'Build lineup templates'],
      estimate: '3 hours',
      actualTime: '1.5 hours',
    });

    const analysisText = 'If you had used PostgreSQL triggers instead of application-level checks, the implementation would have been faster initially but harder to debug.';

    mockCreate.mockResolvedValue(makeTextResponse(analysisText));

    const handlers = await getHandler();
    const result = await handlers['counterfactual_analyze']({
      sprint_phase: 'Phase 69',
      alternative_decision: 'What if we had used PostgreSQL triggers instead of application-level checks?',
    });

    const text = result.content[0].text;

    expect(text).toContain('Counterfactual Analysis');
    expect(text).toContain('Phase 69');
    expect(text).toContain('Practice Builder Enhancements');
    expect(text).toContain(analysisText);
    expect(text).toContain('$0.0200');
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it('includes alternative decision in the prompt sent to Sonnet', async () => {
    writeSprint('sprint-phase70.json', {
      phase: 'Phase 70',
      title: 'Test Sprint',
      status: 'complete',
      completedTasks: ['Task A'],
    });

    mockCreate.mockResolvedValue(makeTextResponse('Analysis result'));

    const handlers = await getHandler();
    await handlers['counterfactual_analyze']({
      sprint_phase: 'Phase 70',
      alternative_decision: 'What if we had chosen microservices instead of a monolith?',
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content;

    expect(userMessage).toContain('What if we had chosen microservices instead of a monolith?');
    expect(userMessage).toContain('Phase 70');
  });

  it('tracks cost with correct model and task type', async () => {
    const { trackUsage } = await import('../../models/token-tracker.js');

    writeSprint('sprint-phase71.json', {
      phase: 'Phase 71',
      title: 'Cost Tracking Test',
      status: 'complete',
      completedTasks: [],
    });

    mockCreate.mockResolvedValue(makeTextResponse('Analysis'));

    const handlers = await getHandler();
    await handlers['counterfactual_analyze']({
      sprint_phase: 'Phase 71',
      alternative_decision: 'What if we had used a different database?',
    });

    expect(trackUsage).toHaveBeenCalledWith(
      'claude-sonnet-4-5-20250929',
      500,
      800,
      'review',
      'counterfactual-analyze',
    );
  });

  it('returns formatted markdown with all sections', async () => {
    writeSprint('sprint-phase72.json', {
      phase: 'Phase 72',
      title: 'Format Test Sprint',
      status: 'complete',
      completedTasks: ['Built causal graph'],
      estimate: '3 hours',
      actualTime: '1.5 hours',
    });

    const analysisText = [
      '**Time Impact**: Would have saved 30 minutes.',
      '**Quality Impact**: Tests would be less comprehensive.',
      '**Risk Changes**: Higher deployment risk.',
      '**Cascade Effects**: Downstream features would need refactoring.',
      '**Confidence Level**: Medium',
      '**Key Takeaway**: The original decision was better for long-term maintenance.',
    ].join('\n\n');

    mockCreate.mockResolvedValue(makeTextResponse(analysisText));

    const handlers = await getHandler();
    const result = await handlers['counterfactual_analyze']({
      sprint_phase: 'Phase 72',
      alternative_decision: 'What if we skipped writing tests?',
    });

    const text = result.content[0].text;

    expect(text).toContain('## Counterfactual Analysis: Phase 72');
    expect(text).toContain('**Sprint:** Phase 72 - Format Test Sprint');
    expect(text).toContain('**Alternative Decision:** What if we skipped writing tests?');
    expect(text).toContain('**Time Impact**');
    expect(text).toContain('**Confidence Level**');
    expect(text).toContain('_Analysis cost: $0.0200 (Sonnet)_');
  });
});

describe('counterfactual_analyze — missing sprint data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupDirs();
    mockLoadCausalGraph.mockReturnValue({ nodes: [], edges: [] });
  });

  afterEach(() => {
    cleanupDirs();
  });

  it('handles missing sprint gracefully and still calls Sonnet', async () => {
    // No sprint files exist at all
    mockCreate.mockResolvedValue(makeTextResponse('Analysis without sprint data'));

    const handlers = await getHandler();
    const result = await handlers['counterfactual_analyze']({
      sprint_phase: 'Phase 999',
      alternative_decision: 'What if we had used a different framework?',
    });

    const text = result.content[0].text;

    expect(text).toContain('Counterfactual Analysis');
    expect(text).toContain('Phase 999');
    expect(text).toContain('Analysis without sprint data');
    expect(mockCreate).toHaveBeenCalledOnce();

    // Verify the prompt mentions no data available
    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content;
    expect(userMessage).toContain('No sprint data available');
  });
});

describe('counterfactual_analyze — causal graph integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupDirs();
    ensureDirs();
  });

  afterEach(() => {
    cleanupDirs();
  });

  it('includes causal graph context when available', async () => {
    writeSprint('sprint-phase69.json', {
      phase: 'Phase 69',
      title: 'Causal Test',
      status: 'complete',
      completedTasks: ['Task A'],
    });

    mockLoadCausalGraph.mockReturnValue({
      nodes: [
        { id: 'd-phase69-1', type: 'decision', label: 'Used parallel agents', sprint: 'Phase 69', date: '2026-02-12' },
        { id: 'o-phase69-1', type: 'outcome', label: 'Faster completion', sprint: 'Phase 69', date: '2026-02-12' },
      ],
      edges: [
        { from: 'd-phase69-1', to: 'o-phase69-1', strength: 8, evidence: 'Parallel execution halved time' },
      ],
    });

    mockCreate.mockResolvedValue(makeTextResponse('Analysis with causal context'));

    const handlers = await getHandler();
    await handlers['counterfactual_analyze']({
      sprint_phase: 'Phase 69',
      alternative_decision: 'What if we had used sequential execution?',
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content;

    expect(userMessage).toContain('Used parallel agents');
    expect(userMessage).toContain('Faster completion');
    expect(userMessage).toContain('Parallel execution halved time');
    expect(userMessage).toContain('Causal Relationships');
  });

  it('works correctly when causal graph is empty', async () => {
    writeSprint('sprint-phase70.json', {
      phase: 'Phase 70',
      title: 'Empty Graph Test',
      status: 'complete',
      completedTasks: ['Task X'],
    });

    mockLoadCausalGraph.mockReturnValue({ nodes: [], edges: [] });
    mockCreate.mockResolvedValue(makeTextResponse('Analysis without causal data'));

    const handlers = await getHandler();
    const result = await handlers['counterfactual_analyze']({
      sprint_phase: 'Phase 70',
      alternative_decision: 'What if we had chosen a different approach?',
    });

    const text = result.content[0].text;

    expect(text).toContain('Analysis without causal data');
    expect(mockCreate).toHaveBeenCalledOnce();

    // Verify no causal context in the prompt
    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content;
    expect(userMessage).not.toContain('Causal Relationships');
  });

  it('does not break when causal graph has nodes for other sprints only', async () => {
    writeSprint('sprint-phase73.json', {
      phase: 'Phase 73',
      title: 'Unrelated Causal Test',
      status: 'complete',
      completedTasks: ['Task A'],
    });

    mockLoadCausalGraph.mockReturnValue({
      nodes: [
        { id: 'd-phase50-1', type: 'decision', label: 'Old decision', sprint: 'Phase 50', date: '2026-01-01' },
      ],
      edges: [],
    });

    mockCreate.mockResolvedValue(makeTextResponse('Analysis result'));

    const handlers = await getHandler();
    const result = await handlers['counterfactual_analyze']({
      sprint_phase: 'Phase 73',
      alternative_decision: 'What if we had done things differently?',
    });

    expect(result.content[0].text).toContain('Analysis result');

    // No causal context should be included since nodes are from different sprint
    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content;
    expect(userMessage).not.toContain('Old decision');
  });
});

describe('counterfactual_analyze — sprint data formats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupDirs();
    ensureDirs();
    mockLoadCausalGraph.mockReturnValue({ nodes: [], edges: [] });
  });

  afterEach(() => {
    cleanupDirs();
  });

  it('handles tasks as objects with title and status', async () => {
    writeSprint('sprint-phase74.json', {
      phase: 'Phase 74',
      title: 'Object Tasks Test',
      status: 'complete',
      tasks: [
        { title: 'Add drag-and-drop', status: 'done' },
        { title: 'Build templates', status: 'done' },
      ],
    });

    mockCreate.mockResolvedValue(makeTextResponse('Object task analysis'));

    const handlers = await getHandler();
    await handlers['counterfactual_analyze']({
      sprint_phase: 'Phase 74',
      alternative_decision: 'What if we used a different UI library?',
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content;

    expect(userMessage).toContain('Add drag-and-drop');
    expect(userMessage).toContain('[done]');
  });

  it('falls back to current.json when archive has no match', async () => {
    // Write current sprint (not in archive)
    const sprintDir = join('/tmp/test-cf-radl', '.planning/sprints');
    writeFileSync(join(sprintDir, 'current.json'), JSON.stringify({
      phase: 'Phase 75',
      title: 'Current Sprint',
      status: 'active',
      completedTasks: ['In progress task'],
    }));

    mockCreate.mockResolvedValue(makeTextResponse('Current sprint analysis'));

    const handlers = await getHandler();
    const result = await handlers['counterfactual_analyze']({
      sprint_phase: 'Phase 75',
      alternative_decision: 'What if we had started with a different task?',
    });

    const text = result.content[0].text;
    expect(text).toContain('Current Sprint');
  });
});
