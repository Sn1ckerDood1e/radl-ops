import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

// ============================================
// Mocks
// ============================================

const TEST_KNOWLEDGE_DIR = '/tmp/test-immune-knowledge';

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
  calculateCost: vi.fn(() => 0.001),
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
      name: 'classify_antibody',
      input,
    }],
    usage: { input_tokens: 300, output_tokens: 150 },
  };
}

function makeTextResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 300, output_tokens: 150 },
  };
}

function makeAntibody(overrides: Partial<import('./immune-system.js').Antibody> = {}): import('./immune-system.js').Antibody {
  return {
    id: 1,
    trigger: 'Adding a Prisma field without updating API handler',
    triggerKeywords: ['prisma', 'field', 'handler', 'route', 'api', 'schema'],
    check: 'Verify the API route handler destructures the new field',
    checkType: 'grep',
    checkPattern: 'updateData.*fieldName',
    origin: { sprint: 'Phase 69', bug: 'Field silently discarded' },
    catches: 3,
    falsePositives: 0,
    falsePositiveRate: 0,
    active: true,
    createdAt: '2026-02-15T00:00:00.000Z',
    ...overrides,
  };
}

async function getHandlers() {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
  };

  const mod = await import('./immune-system.js');
  mod.registerImmuneSystemTools(mockServer as any);
  return handlers;
}

// ============================================
// Tests
// ============================================

describe('Immune System — matchAntibodies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns antibodies with 2+ keyword overlap', async () => {
    const { matchAntibodies } = await import('./immune-system.js');

    const antibodies = [
      makeAntibody({ id: 1, triggerKeywords: ['prisma', 'field', 'handler', 'route', 'api'] }),
      makeAntibody({ id: 2, triggerKeywords: ['csrf', 'header', 'fetch', 'client'] }),
    ];

    const matches = matchAntibodies('Added new prisma field to schema and updated handler', antibodies);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(1);
  });

  it('returns empty when fewer than 2 keywords match', async () => {
    const { matchAntibodies } = await import('./immune-system.js');

    const antibodies = [
      makeAntibody({ triggerKeywords: ['prisma', 'field', 'handler'] }),
    ];

    const matches = matchAntibodies('Added a new component', antibodies);
    expect(matches).toHaveLength(0);
  });

  it('skips inactive antibodies', async () => {
    const { matchAntibodies } = await import('./immune-system.js');

    const antibodies = [
      makeAntibody({ id: 1, active: false, triggerKeywords: ['prisma', 'field', 'handler'] }),
    ];

    const matches = matchAntibodies('Updated prisma field and handler', antibodies);
    expect(matches).toHaveLength(0);
  });

  it('matches case-insensitively', async () => {
    const { matchAntibodies } = await import('./immune-system.js');

    const antibodies = [
      makeAntibody({ triggerKeywords: ['prisma', 'field', 'handler'] }),
    ];

    const matches = matchAntibodies('PRISMA FIELD update', antibodies);
    expect(matches).toHaveLength(1);
  });

  it('returns multiple matching antibodies', async () => {
    const { matchAntibodies } = await import('./immune-system.js');

    const antibodies = [
      makeAntibody({ id: 1, triggerKeywords: ['prisma', 'field', 'schema'] }),
      makeAntibody({ id: 2, triggerKeywords: ['prisma', 'migration', 'schema'] }),
    ];

    const matches = matchAntibodies('Updated prisma schema and migration', antibodies);
    expect(matches).toHaveLength(2);
  });
});

describe('Immune System — loadAntibodies / saveAntibodies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_KNOWLEDGE_DIR)) {
      rmSync(TEST_KNOWLEDGE_DIR, { recursive: true });
    }
    mkdirSync(TEST_KNOWLEDGE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_KNOWLEDGE_DIR)) {
      rmSync(TEST_KNOWLEDGE_DIR, { recursive: true });
    }
  });

  it('returns empty store when file does not exist', async () => {
    const { loadAntibodies } = await import('./immune-system.js');
    const store = loadAntibodies();
    expect(store.antibodies).toEqual([]);
  });

  it('round-trips correctly', async () => {
    const { loadAntibodies, saveAntibodies } = await import('./immune-system.js');

    const antibody = makeAntibody();
    saveAntibodies({ antibodies: [antibody] });

    const loaded = loadAntibodies();
    expect(loaded.antibodies).toHaveLength(1);
    expect(loaded.antibodies[0].id).toBe(antibody.id);
    expect(loaded.antibodies[0].trigger).toBe(antibody.trigger);
    expect(loaded.antibodies[0].triggerKeywords).toEqual(antibody.triggerKeywords);
    expect(loaded.antibodies[0].checkType).toBe(antibody.checkType);
    expect(loaded.antibodies[0].checkPattern).toBe(antibody.checkPattern);
    expect(loaded.antibodies[0].active).toBe(true);
  });

  it('creates knowledge directory if missing', async () => {
    const { saveAntibodies } = await import('./immune-system.js');

    rmSync(TEST_KNOWLEDGE_DIR, { recursive: true });
    expect(existsSync(TEST_KNOWLEDGE_DIR)).toBe(false);

    saveAntibodies({ antibodies: [makeAntibody()] });
    expect(existsSync(join(TEST_KNOWLEDGE_DIR, 'antibodies.json'))).toBe(true);
  });

  it('handles corrupted JSON gracefully', async () => {
    const { writeFileSync } = await import('fs');
    const { loadAntibodies } = await import('./immune-system.js');

    writeFileSync(join(TEST_KNOWLEDGE_DIR, 'antibodies.json'), 'not valid json{{{');
    const store = loadAntibodies();
    expect(store.antibodies).toEqual([]);
  });
});

describe('Immune System — antibody_disable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_KNOWLEDGE_DIR)) {
      rmSync(TEST_KNOWLEDGE_DIR, { recursive: true });
    }
    mkdirSync(TEST_KNOWLEDGE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_KNOWLEDGE_DIR)) {
      rmSync(TEST_KNOWLEDGE_DIR, { recursive: true });
    }
  });

  it('sets active to false for an existing antibody', async () => {
    const { saveAntibodies, loadAntibodies } = await import('./immune-system.js');

    saveAntibodies({ antibodies: [makeAntibody({ id: 1, active: true })] });

    const handlers = await getHandlers();
    const result = await handlers['antibody_disable']({ id: 1, reason: 'Too many false positives' });

    expect(result.content[0].text).toContain('Antibody #1 disabled');
    expect(result.content[0].text).toContain('Too many false positives');

    const updated = loadAntibodies();
    expect(updated.antibodies[0].active).toBe(false);
  });

  it('returns error when antibody not found', async () => {
    const { saveAntibodies } = await import('./immune-system.js');

    saveAntibodies({ antibodies: [] });

    const handlers = await getHandlers();
    const result = await handlers['antibody_disable']({ id: 999 });

    expect(result.content[0].text).toContain('not found');
    expect(result.isError).toBe(true);
  });

  it('reports already disabled antibody', async () => {
    const { saveAntibodies } = await import('./immune-system.js');

    saveAntibodies({ antibodies: [makeAntibody({ id: 1, active: false })] });

    const handlers = await getHandlers();
    const result = await handlers['antibody_disable']({ id: 1 });

    expect(result.content[0].text).toContain('already disabled');
  });

  it('does not affect other antibodies', async () => {
    const { saveAntibodies, loadAntibodies } = await import('./immune-system.js');

    saveAntibodies({
      antibodies: [
        makeAntibody({ id: 1, active: true }),
        makeAntibody({ id: 2, active: true, trigger: 'Second antibody' }),
      ],
    });

    const handlers = await getHandlers();
    await handlers['antibody_disable']({ id: 1 });

    const updated = loadAntibodies();
    expect(updated.antibodies[0].active).toBe(false);
    expect(updated.antibodies[1].active).toBe(true);
  });
});

describe('Immune System — antibody_create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_KNOWLEDGE_DIR)) {
      rmSync(TEST_KNOWLEDGE_DIR, { recursive: true });
    }
    mkdirSync(TEST_KNOWLEDGE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_KNOWLEDGE_DIR)) {
      rmSync(TEST_KNOWLEDGE_DIR, { recursive: true });
    }
  });

  it('creates antibody from AI classification and saves to JSON', async () => {
    const { loadAntibodies } = await import('./immune-system.js');

    mockCreate.mockResolvedValue(makeToolUseResponse({
      trigger: 'Adding a new Prisma field without updating the API handler',
      triggerKeywords: ['prisma', 'field', 'handler', 'route', 'api', 'schema'],
      check: 'Verify the API route handler destructures the new field',
      checkType: 'grep',
      checkPattern: 'updateData.*newField',
    }));

    const handlers = await getHandlers();
    const result = await handlers['antibody_create']({
      bug_description: 'Field was added to Prisma schema but API handler never processed it',
      sprint_phase: 'Phase 69',
    });

    const text = result.content[0].text;
    expect(text).toContain('Antibody #1 Created');
    expect(text).toContain('Adding a new Prisma field');
    expect(text).toContain('prisma, field, handler, route, api, schema');
    expect(text).toContain('grep');
    expect(text).toContain('Cost: ~$');

    const store = loadAntibodies();
    expect(store.antibodies).toHaveLength(1);
    expect(store.antibodies[0].id).toBe(1);
    expect(store.antibodies[0].active).toBe(true);
    expect(store.antibodies[0].origin.sprint).toBe('Phase 69');
    expect(store.antibodies[0].checkType).toBe('grep');
  });

  it('assigns incremental IDs', async () => {
    const { saveAntibodies, loadAntibodies } = await import('./immune-system.js');

    saveAntibodies({ antibodies: [makeAntibody({ id: 5 })] });

    mockCreate.mockResolvedValue(makeToolUseResponse({
      trigger: 'New trigger',
      triggerKeywords: ['keyword1', 'keyword2', 'keyword3'],
      check: 'Check something',
      checkType: 'manual',
      checkPattern: null,
    }));

    const handlers = await getHandlers();
    await handlers['antibody_create']({
      bug_description: 'Some new bug description here',
    });

    const store = loadAntibodies();
    expect(store.antibodies).toHaveLength(2);
    expect(store.antibodies[1].id).toBe(6);
  });

  it('returns error when AI fails to produce structured output', async () => {
    mockCreate.mockResolvedValue(makeTextResponse('I could not classify this bug'));

    const handlers = await getHandlers();
    const result = await handlers['antibody_create']({
      bug_description: 'Some vague bug description',
    });

    expect(result.content[0].text).toContain('Failed to classify');
    expect(result.isError).toBe(true);
  });

  it('includes code context in prompt when provided', async () => {
    mockCreate.mockResolvedValue(makeToolUseResponse({
      trigger: 'Test trigger',
      triggerKeywords: ['test', 'keyword', 'check'],
      check: 'Test check',
      checkType: 'manual',
      checkPattern: null,
    }));

    const handlers = await getHandlers();
    await handlers['antibody_create']({
      bug_description: 'Bug with code context',
      code_context: 'const x = 1;',
      sprint_phase: 'Phase 70',
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content;
    expect(userMessage).toContain('Code context');
    expect(userMessage).toContain('const x = 1;');
    expect(userMessage).toContain('Phase 70');
  });

  it('calls Anthropic with correct model and tool_choice', async () => {
    mockCreate.mockResolvedValue(makeToolUseResponse({
      trigger: 'Test',
      triggerKeywords: ['a', 'b', 'c'],
      check: 'Test',
      checkType: 'manual',
      checkPattern: null,
    }));

    const handlers = await getHandlers();
    await handlers['antibody_create']({
      bug_description: 'Test bug for model verification',
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        tool_choice: { type: 'tool', name: 'classify_antibody' },
      })
    );
  });

  it('tracks usage after API call', async () => {
    const { trackUsage } = await import('../../models/token-tracker.js');

    mockCreate.mockResolvedValue(makeToolUseResponse({
      trigger: 'Test',
      triggerKeywords: ['a', 'b', 'c'],
      check: 'Test',
      checkType: 'manual',
      checkPattern: null,
    }));

    const handlers = await getHandlers();
    await handlers['antibody_create']({
      bug_description: 'Test bug for usage tracking',
    });

    expect(trackUsage).toHaveBeenCalledWith(
      'claude-haiku-4-5-20251001',
      300,
      150,
      'spot_check',
      'antibody-create',
    );
  });
});

describe('Immune System — antibody_list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_KNOWLEDGE_DIR)) {
      rmSync(TEST_KNOWLEDGE_DIR, { recursive: true });
    }
    mkdirSync(TEST_KNOWLEDGE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_KNOWLEDGE_DIR)) {
      rmSync(TEST_KNOWLEDGE_DIR, { recursive: true });
    }
  });

  it('shows empty message when no antibodies exist', async () => {
    const handlers = await getHandlers();
    const result = await handlers['antibody_list']({ active_only: false });

    expect(result.content[0].text).toContain('No antibodies registered');
  });

  it('lists all antibodies as markdown table', async () => {
    const { saveAntibodies } = await import('./immune-system.js');

    saveAntibodies({
      antibodies: [
        makeAntibody({ id: 1 }),
        makeAntibody({ id: 2, active: false, trigger: 'Disabled trigger' }),
      ],
    });

    const handlers = await getHandlers();
    const result = await handlers['antibody_list']({ active_only: false });
    const text = result.content[0].text;

    expect(text).toContain('Antibody Library');
    expect(text).toContain('Total:** 2');
    expect(text).toContain('Active:** 1');
    expect(text).toContain('Antibody #1');
    expect(text).toContain('Antibody #2');
    expect(text).toContain('DISABLED');
  });

  it('filters to active only when requested', async () => {
    const { saveAntibodies } = await import('./immune-system.js');

    saveAntibodies({
      antibodies: [
        makeAntibody({ id: 1, active: true }),
        makeAntibody({ id: 2, active: false, trigger: 'Disabled' }),
      ],
    });

    const handlers = await getHandlers();
    const result = await handlers['antibody_list']({ active_only: true });
    const text = result.content[0].text;

    expect(text).toContain('Antibody #1');
    expect(text).not.toContain('Antibody #2');
  });
});

describe('Immune System — createAntibodyCore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TEST_KNOWLEDGE_DIR)) {
      rmSync(TEST_KNOWLEDGE_DIR, { recursive: true });
    }
    mkdirSync(TEST_KNOWLEDGE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_KNOWLEDGE_DIR)) {
      rmSync(TEST_KNOWLEDGE_DIR, { recursive: true });
    }
  });

  it('creates antibody and returns id + trigger on success', async () => {
    const { createAntibodyCore, loadAntibodies } = await import('./immune-system.js');

    mockCreate.mockResolvedValue(makeToolUseResponse({
      trigger: 'Missing API handler field',
      triggerKeywords: ['api', 'handler', 'field', 'route'],
      check: 'Verify handler processes new field',
      checkType: 'manual',
      checkPattern: null,
    }));

    const result = await createAntibodyCore(
      'API handler did not process the new field',
      undefined,
      'Phase 92',
    );

    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
    expect(result!.trigger).toBe('Missing API handler field');

    const store = loadAntibodies();
    expect(store.antibodies).toHaveLength(1);
    expect(store.antibodies[0].origin.sprint).toBe('Phase 92');
  });

  it('returns null when AI fails to produce structured output', async () => {
    const { createAntibodyCore } = await import('./immune-system.js');

    mockCreate.mockResolvedValue(makeTextResponse('Cannot classify this'));

    const result = await createAntibodyCore('vague description');
    expect(result).toBeNull();
  });

  it('uses unknown phase when not provided', async () => {
    const { createAntibodyCore, loadAntibodies } = await import('./immune-system.js');

    mockCreate.mockResolvedValue(makeToolUseResponse({
      trigger: 'Test trigger',
      triggerKeywords: ['test', 'trigger', 'check'],
      check: 'Test check',
      checkType: 'manual',
      checkPattern: null,
    }));

    await createAntibodyCore('Some bug description');

    const store = loadAntibodies();
    expect(store.antibodies[0].origin.sprint).toBe('unknown');
  });
});

describe('Immune System — tool registration', () => {
  it('registers all three tools', async () => {
    const tools: string[] = [];
    const mockServer = {
      tool: (...args: unknown[]) => {
        tools.push(args[0] as string);
      },
    };

    const { registerImmuneSystemTools } = await import('./immune-system.js');
    registerImmuneSystemTools(mockServer as any);

    expect(tools).toContain('antibody_create');
    expect(tools).toContain('antibody_list');
    expect(tools).toContain('antibody_disable');
    expect(tools).toHaveLength(3);
  });
});
