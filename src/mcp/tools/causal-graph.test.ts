import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// ============================================
// Mocks
// ============================================

const TEST_KNOWLEDGE_DIR = '/tmp/test-causal-knowledge';
const TEST_SPRINT_DIR = '/tmp/test-radl/.planning/sprints';

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
    radlDir: '/tmp/test-radl',
    radlOpsDir: '/tmp/test-ops',
    knowledgeDir: TEST_KNOWLEDGE_DIR,
    usageLogsDir: '/tmp/test-logs',
    sprintScript: '/tmp/test.sh',
    compoundScript: '/tmp/test-compound.sh',
  })),
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

// ============================================
// Helpers
// ============================================

function makeToolUseResponse(input: Record<string, unknown>) {
  return {
    content: [{
      type: 'tool_use',
      id: 'call_abc',
      name: 'submit_causal_graph',
      input,
    }],
    usage: { input_tokens: 500, output_tokens: 300 },
  };
}

function makeSampleGraph(): import('./causal-graph.js').CausalGraph {
  return {
    nodes: [
      { id: 'd-phase70-1', type: 'decision', label: 'Use parallel agents', sprint: 'Phase 70', date: '2026-02-10' },
      { id: 'o-phase70-1', type: 'outcome', label: 'Faster sprint completion', sprint: 'Phase 70', date: '2026-02-10' },
      { id: 'c-phase70-1', type: 'condition', label: 'Time pressure', sprint: 'Phase 70', date: '2026-02-10' },
      { id: 'd-phase70-2', type: 'decision', label: 'Strict file ownership', sprint: 'Phase 70', date: '2026-02-10' },
      { id: 'o-phase70-2', type: 'outcome', label: 'Zero merge conflicts', sprint: 'Phase 70', date: '2026-02-10' },
    ],
    edges: [
      { from: 'c-phase70-1', to: 'd-phase70-1', strength: 7, evidence: 'Time pressure drove parallel approach' },
      { from: 'd-phase70-1', to: 'o-phase70-1', strength: 8, evidence: '4 agents completed in 45 min vs estimated 2h' },
      { from: 'd-phase70-2', to: 'o-phase70-2', strength: 9, evidence: 'Each file had exactly one owner' },
      { from: 'd-phase70-1', to: 'd-phase70-2', strength: 6, evidence: 'Parallel agents required ownership rules' },
    ],
  };
}

function ensureDirs(): void {
  if (!existsSync(TEST_KNOWLEDGE_DIR)) {
    mkdirSync(TEST_KNOWLEDGE_DIR, { recursive: true });
  }
  const archiveDir = join(TEST_SPRINT_DIR, 'archive');
  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }
}

function cleanupDirs(): void {
  if (existsSync(TEST_KNOWLEDGE_DIR)) {
    rmSync(TEST_KNOWLEDGE_DIR, { recursive: true });
  }
  if (existsSync('/tmp/test-radl')) {
    rmSync('/tmp/test-radl', { recursive: true });
  }
}

async function getHandlers() {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
  };

  const mod = await import('./causal-graph.js');
  mod.registerCausalGraphTools(mockServer as any);
  return handlers;
}

// ============================================
// Tests
// ============================================

describe('findRelevantCauses', () => {
  it('finds nodes by keywords and returns connected subgraph with chains', async () => {
    const { findRelevantCauses } = await import('./causal-graph.js');
    const graph = makeSampleGraph();

    const result = findRelevantCauses(graph, ['parallel']);

    // Should find 'd-phase70-1' (label contains 'parallel')
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes.some(n => n.id === 'd-phase70-1')).toBe(true);

    // BFS 2 hops should reach connected nodes
    expect(result.nodes.some(n => n.id === 'o-phase70-1')).toBe(true);
    expect(result.nodes.some(n => n.id === 'c-phase70-1')).toBe(true);

    // Should have edges in the subgraph
    expect(result.edges.length).toBeGreaterThan(0);

    // Chains should be human-readable
    expect(result.chains.length).toBeGreaterThan(0);
    expect(result.chains.some(c => c.includes('->') && c.includes('evidence:'))).toBe(true);
  });

  it('returns empty for no keyword matches', async () => {
    const { findRelevantCauses } = await import('./causal-graph.js');
    const graph = makeSampleGraph();

    const result = findRelevantCauses(graph, ['nonexistent-keyword-xyz']);

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.chains).toEqual([]);
  });

  it('returns empty for empty graph', async () => {
    const { findRelevantCauses } = await import('./causal-graph.js');
    const emptyGraph = { nodes: [], edges: [] };

    const result = findRelevantCauses(emptyGraph, ['anything']);

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.chains).toEqual([]);
  });

  it('returns empty for empty keywords', async () => {
    const { findRelevantCauses } = await import('./causal-graph.js');
    const graph = makeSampleGraph();

    const result = findRelevantCauses(graph, []);

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.chains).toEqual([]);
  });

  it('matches multiple keywords and deduplicates seed nodes', async () => {
    const { findRelevantCauses } = await import('./causal-graph.js');
    const graph = makeSampleGraph();

    const result = findRelevantCauses(graph, ['parallel', 'ownership']);

    // Should find both d-phase70-1 (parallel) and d-phase70-2 (ownership)
    expect(result.nodes.some(n => n.id === 'd-phase70-1')).toBe(true);
    expect(result.nodes.some(n => n.id === 'd-phase70-2')).toBe(true);
  });
});

describe('loadCausalGraph / saveCausalGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupDirs();
    ensureDirs();
  });

  afterEach(() => {
    cleanupDirs();
  });

  it('returns empty graph when file does not exist', async () => {
    const { loadCausalGraph } = await import('./causal-graph.js');
    const graph = loadCausalGraph();

    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it('round-trips correctly', async () => {
    const { loadCausalGraph, saveCausalGraph } = await import('./causal-graph.js');
    const original = makeSampleGraph();

    saveCausalGraph(original);
    const loaded = loadCausalGraph();

    expect(loaded.nodes).toHaveLength(original.nodes.length);
    expect(loaded.edges).toHaveLength(original.edges.length);
    expect(loaded.nodes[0].id).toBe(original.nodes[0].id);
    expect(loaded.nodes[0].label).toBe(original.nodes[0].label);
    expect(loaded.nodes[0].type).toBe(original.nodes[0].type);
    expect(loaded.edges[0].from).toBe(original.edges[0].from);
    expect(loaded.edges[0].to).toBe(original.edges[0].to);
    expect(loaded.edges[0].strength).toBe(original.edges[0].strength);
    expect(loaded.edges[0].evidence).toBe(original.edges[0].evidence);
  });

  it('handles corrupted JSON gracefully', async () => {
    const { loadCausalGraph } = await import('./causal-graph.js');

    writeFileSync(join(TEST_KNOWLEDGE_DIR, 'causal-graph.json'), 'not valid json{{{');
    const graph = loadCausalGraph();

    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });
});

describe('causal_query — by node_id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupDirs();
    ensureDirs();
  });

  afterEach(() => {
    cleanupDirs();
  });

  it('BFS traversal from node_id in specified direction', async () => {
    const { saveCausalGraph } = await import('./causal-graph.js');
    saveCausalGraph(makeSampleGraph());

    const handlers = await getHandlers();
    const result = await handlers['causal_query']({
      node_id: 'd-phase70-1',
      direction: 'forward',
    });
    const text = result.content[0].text;

    // Forward from d-phase70-1 should reach o-phase70-1 and d-phase70-2
    expect(text).toContain('Use parallel agents');
    expect(text).toContain('Faster sprint completion');
  });

  it('returns error for nonexistent node_id', async () => {
    const { saveCausalGraph } = await import('./causal-graph.js');
    saveCausalGraph(makeSampleGraph());

    const handlers = await getHandlers();
    const result = await handlers['causal_query']({
      node_id: 'nonexistent-id',
    });
    const text = result.content[0].text;

    expect(text).toContain('not found');
    expect(text).toContain('Available nodes');
  });

  it('backward traversal reaches causes', async () => {
    const { saveCausalGraph } = await import('./causal-graph.js');
    saveCausalGraph(makeSampleGraph());

    const handlers = await getHandlers();
    const result = await handlers['causal_query']({
      node_id: 'o-phase70-1',
      direction: 'backward',
    });
    const text = result.content[0].text;

    // Backward from o-phase70-1 should reach d-phase70-1 (and c-phase70-1 via 2 hops)
    expect(text).toContain('Use parallel agents');
    expect(text).toContain('Time pressure');
  });

  it('returns empty message for empty graph', async () => {
    const { saveCausalGraph } = await import('./causal-graph.js');
    saveCausalGraph({ nodes: [], edges: [] });

    const handlers = await getHandlers();
    const result = await handlers['causal_query']({
      node_id: 'd-phase70-1',
    });
    const text = result.content[0].text;

    expect(text).toContain('empty');
  });
});

describe('causal_query — by keywords', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupDirs();
    ensureDirs();
  });

  afterEach(() => {
    cleanupDirs();
  });

  it('finds matching nodes and traverses from them', async () => {
    const { saveCausalGraph } = await import('./causal-graph.js');
    saveCausalGraph(makeSampleGraph());

    const handlers = await getHandlers();
    const result = await handlers['causal_query']({
      keywords: 'merge conflicts',
    });
    const text = result.content[0].text;

    // Should find o-phase70-2 ('Zero merge conflicts')
    expect(text).toContain('Zero merge conflicts');
    // BFS should also reach d-phase70-2
    expect(text).toContain('Strict file ownership');
  });

  it('returns no-match message for unrecognized keywords', async () => {
    const { saveCausalGraph } = await import('./causal-graph.js');
    saveCausalGraph(makeSampleGraph());

    const handlers = await getHandlers();
    const result = await handlers['causal_query']({
      keywords: 'completely-unrelated-topic',
    });
    const text = result.content[0].text;

    expect(text).toContain('No nodes found matching');
  });
});

describe('causal_extract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupDirs();
    ensureDirs();
  });

  afterEach(() => {
    cleanupDirs();
  });

  it('mocks AI and verifies nodes/edges written to JSON', async () => {
    const { loadCausalGraph } = await import('./causal-graph.js');

    // Write a sprint data file
    const archiveDir = join(TEST_SPRINT_DIR, 'archive');
    writeFileSync(join(archiveDir, 'sprint-phase72.json'), JSON.stringify({
      phase: 'Phase 72',
      title: 'Causal Graph Implementation',
      status: 'complete',
      completedTasks: ['Built causal graph tool', 'Added BFS traversal'],
      blockers: [],
      estimate: '3 hours',
      actualTime: '1.5 hours',
    }));

    // Write initial empty graph
    writeFileSync(join(TEST_KNOWLEDGE_DIR, 'causal-graph.json'), JSON.stringify({
      nodes: [],
      edges: [],
    }));

    // Mock Haiku response
    mockCreate.mockResolvedValue(makeToolUseResponse({
      nodes: [
        { id: 'd-phase72-1', type: 'decision', label: 'Chose BFS over DFS', sprint: 'Phase 72', date: '2026-02-16' },
        { id: 'o-phase72-1', type: 'outcome', label: 'Simple traversal code', sprint: 'Phase 72', date: '2026-02-16' },
      ],
      edges: [
        { from: 'd-phase72-1', to: 'o-phase72-1', strength: 8, evidence: 'BFS is simpler for bounded depth search' },
      ],
    }));

    const handlers = await getHandlers();
    const result = await handlers['causal_extract']({});
    const text = result.content[0].text;

    // Verify output format
    expect(text).toContain('Causal Extract');
    expect(text).toContain('Phase 72');
    expect(text).toContain('Chose BFS over DFS');
    expect(text).toContain('Simple traversal code');
    expect(text).toContain('2 new');

    // Verify data persisted to file
    const savedGraph = loadCausalGraph();
    expect(savedGraph.nodes).toHaveLength(2);
    expect(savedGraph.edges).toHaveLength(1);
    expect(savedGraph.nodes[0].id).toBe('d-phase72-1');
    expect(savedGraph.edges[0].evidence).toBe('BFS is simpler for bounded depth search');
  });

  it('returns message when no sprint data found', async () => {
    // No sprint files exist — clean dirs already empty
    rmSync('/tmp/test-radl', { recursive: true, force: true });

    const handlers = await getHandlers();
    const result = await handlers['causal_extract']({});
    const text = result.content[0].text;

    expect(text).toContain('No sprint data found');
  });

  it('skips duplicate nodes on re-extraction', async () => {
    const { loadCausalGraph, saveCausalGraph } = await import('./causal-graph.js');

    // Pre-populate graph with one node
    saveCausalGraph({
      nodes: [
        { id: 'd-phase72-1', type: 'decision', label: 'Chose BFS over DFS', sprint: 'Phase 72', date: '2026-02-16' },
      ],
      edges: [],
    });

    // Write sprint data
    ensureDirs();
    const archiveDir = join(TEST_SPRINT_DIR, 'archive');
    writeFileSync(join(archiveDir, 'sprint-phase72.json'), JSON.stringify({
      phase: 'Phase 72',
      title: 'Test Sprint',
      status: 'complete',
      completedTasks: ['Task A'],
    }));

    // AI returns the same node plus a new one
    mockCreate.mockResolvedValue(makeToolUseResponse({
      nodes: [
        { id: 'd-phase72-1', type: 'decision', label: 'Chose BFS over DFS', sprint: 'Phase 72', date: '2026-02-16' },
        { id: 'o-phase72-1', type: 'outcome', label: 'New outcome', sprint: 'Phase 72', date: '2026-02-16' },
      ],
      edges: [
        { from: 'd-phase72-1', to: 'o-phase72-1', strength: 7, evidence: 'Direct causation' },
      ],
    }));

    const handlers = await getHandlers();
    const result = await handlers['causal_extract']({});
    const text = result.content[0].text;

    // Should report 1 new node (not 2)
    expect(text).toContain('1 new');

    // Graph should have 2 total nodes
    const savedGraph = loadCausalGraph();
    expect(savedGraph.nodes).toHaveLength(2);
    expect(savedGraph.edges).toHaveLength(1);
  });

  it('tracks usage after API call', async () => {
    const { trackUsage } = await import('../../models/token-tracker.js');

    ensureDirs();
    const archiveDir = join(TEST_SPRINT_DIR, 'archive');
    writeFileSync(join(archiveDir, 'sprint-phase72.json'), JSON.stringify({
      phase: 'Phase 72',
      title: 'Test',
      status: 'complete',
      completedTasks: [],
    }));

    writeFileSync(join(TEST_KNOWLEDGE_DIR, 'causal-graph.json'), JSON.stringify({
      nodes: [],
      edges: [],
    }));

    mockCreate.mockResolvedValue(makeToolUseResponse({
      nodes: [{ id: 'd-test-1', type: 'decision', label: 'Test', sprint: 'test', date: '2026-02-16' }],
      edges: [],
    }));

    const handlers = await getHandlers();
    await handlers['causal_extract']({});

    expect(trackUsage).toHaveBeenCalledWith(
      'claude-haiku-4-5-20251001',
      500,
      300,
      'spot_check',
      'causal-extract',
    );
  });
});

describe('tool registration', () => {
  it('registers both tools', async () => {
    const tools: string[] = [];
    const mockServer = {
      tool: (...args: unknown[]) => {
        tools.push(args[0] as string);
      },
    };

    const { registerCausalGraphTools } = await import('./causal-graph.js');
    registerCausalGraphTools(mockServer as any);

    expect(tools).toContain('causal_extract');
    expect(tools).toContain('causal_query');
    expect(tools).toHaveLength(2);
  });
});
