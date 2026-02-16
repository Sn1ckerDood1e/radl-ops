import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================
// Mocks
// ============================================

vi.mock('../../config/paths.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('../../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { getConfig } from '../../config/paths.js';
import type { TrustDecision, TrustLedger } from './quality-ratchet.js';

// ============================================
// Helpers
// ============================================

let tempDir: string;

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'quality-ratchet-test-'));
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

function makeDecision(overrides: Partial<TrustDecision> = {}): TrustDecision {
  return {
    id: 1,
    domain: 'code-review',
    decision: 'Applied suggested refactor',
    aiRecommended: 'Extract helper function',
    humanOverride: false,
    outcome: 'success',
    sprint: 'Phase 72',
    recordedAt: '2026-02-15T00:00:00.000Z',
    ...overrides,
  };
}

function writeLedger(decisions: TrustDecision[]): void {
  writeFileSync(
    join(tempDir, 'trust-ledger.json'),
    JSON.stringify({ decisions }, null, 2),
  );
}

function writeAntibodies(antibodies: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(tempDir, 'antibodies.json'),
    JSON.stringify({ antibodies }, null, 2),
  );
}

function writeCrystallized(checks: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(tempDir, 'crystallized.json'),
    JSON.stringify({ checks }, null, 2),
  );
}

async function getHandlers() {
  const { createMockServer } = await import('../test-utils.js');
  const { server, handlers } = createMockServer();

  const { registerQualityRatchetTools } = await import('./quality-ratchet.js');
  registerQualityRatchetTools(server as never);

  return handlers;
}

// ============================================
// Tests
// ============================================

describe('Quality Ratchet — loadTrustLedger / saveTrustLedger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = makeTempDir();
    mockConfig(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty ledger when file does not exist', async () => {
    const { loadTrustLedger } = await import('./quality-ratchet.js');
    const ledger = loadTrustLedger();
    expect(ledger.decisions).toEqual([]);
  });

  it('round-trips correctly through save and load', async () => {
    const { loadTrustLedger, saveTrustLedger } = await import('./quality-ratchet.js');

    const decisions = [
      makeDecision({ id: 1, domain: 'code-review', outcome: 'success' }),
      makeDecision({ id: 2, domain: 'security-review', outcome: 'failure', humanOverride: true }),
    ];

    saveTrustLedger({ decisions });
    const loaded = loadTrustLedger();

    expect(loaded.decisions).toHaveLength(2);
    expect(loaded.decisions[0].id).toBe(1);
    expect(loaded.decisions[0].domain).toBe('code-review');
    expect(loaded.decisions[0].outcome).toBe('success');
    expect(loaded.decisions[1].id).toBe(2);
    expect(loaded.decisions[1].domain).toBe('security-review');
    expect(loaded.decisions[1].humanOverride).toBe(true);
  });

  it('handles corrupted JSON gracefully', async () => {
    const { loadTrustLedger } = await import('./quality-ratchet.js');

    writeFileSync(join(tempDir, 'trust-ledger.json'), 'not valid json{{{');
    const ledger = loadTrustLedger();
    expect(ledger.decisions).toEqual([]);
  });

  it('creates knowledge directory if missing', async () => {
    const { existsSync } = await import('fs');
    const { saveTrustLedger } = await import('./quality-ratchet.js');

    const nestedDir = join(tempDir, 'nested', 'knowledge');
    mockConfig(nestedDir);

    expect(existsSync(nestedDir)).toBe(false);

    saveTrustLedger({ decisions: [makeDecision()] });
    expect(existsSync(join(nestedDir, 'trust-ledger.json'))).toBe(true);
  });
});

describe('Quality Ratchet — checkFalsePositiveRates', () => {
  it('identifies antibodies with high false positive rates', async () => {
    const { checkFalsePositiveRates } = await import('./quality-ratchet.js');

    const antibodies = [
      { id: 1, trigger: 'Good antibody', falsePositiveRate: 0.1 },
      { id: 2, trigger: 'Bad antibody', falsePositiveRate: 0.5 },
      { id: 3, trigger: 'Borderline antibody', falsePositiveRate: 0.3 },
    ];

    const result = checkFalsePositiveRates(antibodies, []);

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('antibody');
    expect(result[0].id).toBe(2);
    expect(result[0].rate).toBe(0.5);
    expect(result[0].label).toBe('Bad antibody');
  });

  it('identifies crystallized checks with high false positive rates', async () => {
    const { checkFalsePositiveRates } = await import('./quality-ratchet.js');

    const crystallizedChecks = [
      { id: 1, trigger: 'Good check', catches: 8, falsePositives: 2 },
      { id: 2, trigger: 'Bad check', catches: 3, falsePositives: 7 },
      { id: 3, trigger: 'Zero activity check', catches: 0, falsePositives: 0 },
    ];

    const result = checkFalsePositiveRates([], crystallizedChecks);

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('crystallized');
    expect(result[0].id).toBe(2);
    expect(result[0].rate).toBe(0.7);
  });

  it('returns empty array for healthy rates', async () => {
    const { checkFalsePositiveRates } = await import('./quality-ratchet.js');

    const antibodies = [
      { id: 1, trigger: 'Healthy antibody', falsePositiveRate: 0.1 },
      { id: 2, trigger: 'Also healthy', falsePositiveRate: 0.0 },
    ];

    const crystallizedChecks = [
      { id: 1, trigger: 'Good check', catches: 10, falsePositives: 1 },
      { id: 2, trigger: 'Perfect check', catches: 5, falsePositives: 0 },
    ];

    const result = checkFalsePositiveRates(antibodies, crystallizedChecks);
    expect(result).toHaveLength(0);
  });

  it('flags both antibodies and crystallized checks together', async () => {
    const { checkFalsePositiveRates } = await import('./quality-ratchet.js');

    const antibodies = [
      { id: 1, trigger: 'Bad antibody', falsePositiveRate: 0.6 },
    ];

    const crystallizedChecks = [
      { id: 1, trigger: 'Bad check', catches: 1, falsePositives: 4 },
    ];

    const result = checkFalsePositiveRates(antibodies, crystallizedChecks);
    expect(result).toHaveLength(2);
    expect(result[0].source).toBe('antibody');
    expect(result[1].source).toBe('crystallized');
  });
});

describe('Quality Ratchet — trust_record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = makeTempDir();
    mockConfig(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('saves new decision with correct id', async () => {
    const { loadTrustLedger } = await import('./quality-ratchet.js');

    writeLedger([
      makeDecision({ id: 1 }),
      makeDecision({ id: 3 }),
    ]);

    const handlers = await getHandlers();
    const result = await handlers['trust_record']({
      domain: 'estimation',
      decision: 'Used 2-hour estimate',
      ai_recommended: '3-hour estimate',
      human_override: true,
      outcome: 'success',
      sprint: 'Phase 73',
    });

    const text = result.content[0].text;
    expect(text).toContain('Decision #4 Recorded');
    expect(text).toContain('estimation');
    expect(text).toContain('success');

    const ledger = loadTrustLedger();
    expect(ledger.decisions).toHaveLength(3);
    expect(ledger.decisions[2].id).toBe(4);
    expect(ledger.decisions[2].domain).toBe('estimation');
    expect(ledger.decisions[2].humanOverride).toBe(true);
    expect(ledger.decisions[2].outcome).toBe('success');
  });

  it('assigns id 1 to first decision in empty ledger', async () => {
    const { loadTrustLedger } = await import('./quality-ratchet.js');

    const handlers = await getHandlers();
    await handlers['trust_record']({
      domain: 'code-review',
      decision: 'First decision',
      ai_recommended: 'AI suggestion',
      human_override: false,
      outcome: 'success',
      sprint: 'Phase 70',
    });

    const ledger = loadTrustLedger();
    expect(ledger.decisions).toHaveLength(1);
    expect(ledger.decisions[0].id).toBe(1);
  });

  it('returns current domain stats after recording', async () => {
    writeLedger([
      makeDecision({ id: 1, domain: 'code-review', outcome: 'success' }),
      makeDecision({ id: 2, domain: 'code-review', outcome: 'success' }),
      makeDecision({ id: 3, domain: 'code-review', outcome: 'failure' }),
    ]);

    const handlers = await getHandlers();
    const result = await handlers['trust_record']({
      domain: 'code-review',
      decision: 'Another decision',
      ai_recommended: 'AI suggestion',
      human_override: false,
      outcome: 'success',
      sprint: 'Phase 72',
    });

    const text = result.content[0].text;
    expect(text).toContain('Current code-review Stats');
    expect(text).toContain('Total decisions:** 4');
    expect(text).toContain('75%');
    expect(text).toContain('MEDIUM');
  });
});

describe('Quality Ratchet — trust_report', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = makeTempDir();
    mockConfig(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('calculates correct success and override rates', async () => {
    writeLedger([
      makeDecision({ id: 1, domain: 'code-review', outcome: 'success', humanOverride: false }),
      makeDecision({ id: 2, domain: 'code-review', outcome: 'success', humanOverride: false }),
      makeDecision({ id: 3, domain: 'code-review', outcome: 'failure', humanOverride: true }),
      makeDecision({ id: 4, domain: 'code-review', outcome: 'success', humanOverride: false }),
      makeDecision({ id: 5, domain: 'code-review', outcome: 'success', humanOverride: true }),
    ]);

    const handlers = await getHandlers();
    const result = await handlers['trust_report']({});

    const text = result.content[0].text;
    expect(text).toContain('code-review');
    expect(text).toContain('80%');
    expect(text).toContain('40%');
    expect(text).toContain('HIGH');
    expect(text).toContain('Total decisions:** 5');
  });

  it('filters by domain when provided', async () => {
    writeLedger([
      makeDecision({ id: 1, domain: 'code-review', outcome: 'success' }),
      makeDecision({ id: 2, domain: 'security-review', outcome: 'failure' }),
      makeDecision({ id: 3, domain: 'estimation', outcome: 'partial' }),
    ]);

    const handlers = await getHandlers();
    const result = await handlers['trust_report']({ domain: 'security-review' });

    const text = result.content[0].text;
    expect(text).toContain('security-review');
    expect(text).toContain('Filtered to domain: security-review');
    expect(text).not.toContain('### code-review');
    expect(text).not.toContain('### estimation');
  });

  it('handles empty ledger gracefully', async () => {
    const handlers = await getHandlers();
    const result = await handlers['trust_report']({});

    const text = result.content[0].text;
    expect(text).toContain('Trust Report');
    expect(text).toContain('No decisions recorded yet');
  });

  it('handles empty ledger with domain filter gracefully', async () => {
    const handlers = await getHandlers();
    const result = await handlers['trust_report']({ domain: 'code-review' });

    const text = result.content[0].text;
    expect(text).toContain('No decisions recorded for domain "code-review"');
  });

  it('includes false positive rates from antibodies and crystallized checks', async () => {
    writeLedger([
      makeDecision({ id: 1, domain: 'code-review', outcome: 'success' }),
    ]);

    writeAntibodies([
      { id: 1, trigger: 'Bad antibody with high FP', falsePositiveRate: 0.5, active: true },
      { id: 2, trigger: 'Good antibody', falsePositiveRate: 0.1, active: true },
    ]);

    writeCrystallized([
      { id: 1, trigger: 'Bad crystallized check', catches: 2, falsePositives: 8, status: 'active' },
      { id: 2, trigger: 'Good crystallized check', catches: 10, falsePositives: 1, status: 'active' },
    ]);

    const handlers = await getHandlers();
    const result = await handlers['trust_report']({});

    const text = result.content[0].text;
    expect(text).toContain('False Positive Alerts');
    expect(text).toContain('Bad antibody with high FP');
    expect(text).toContain('Bad crystallized check');
    expect(text).not.toContain('Good antibody');
    expect(text).not.toContain('Good crystallized check');
  });

  it('shows clean message when no false positive issues', async () => {
    writeLedger([
      makeDecision({ id: 1, domain: 'code-review', outcome: 'success' }),
    ]);

    writeAntibodies([
      { id: 1, trigger: 'Healthy', falsePositiveRate: 0.1 },
    ]);

    writeCrystallized([
      { id: 1, trigger: 'Also healthy', catches: 10, falsePositives: 1 },
    ]);

    const handlers = await getHandlers();
    const result = await handlers['trust_report']({});

    const text = result.content[0].text;
    expect(text).toContain('within acceptable false positive thresholds');
  });

  it('shows multiple domains with correct trust levels', async () => {
    writeLedger([
      // code-review: 4/5 success = 80% = HIGH
      makeDecision({ id: 1, domain: 'code-review', outcome: 'success' }),
      makeDecision({ id: 2, domain: 'code-review', outcome: 'success' }),
      makeDecision({ id: 3, domain: 'code-review', outcome: 'success' }),
      makeDecision({ id: 4, domain: 'code-review', outcome: 'success' }),
      makeDecision({ id: 5, domain: 'code-review', outcome: 'failure' }),
      // estimation: 1/3 success = 33% = LOW
      makeDecision({ id: 6, domain: 'estimation', outcome: 'success' }),
      makeDecision({ id: 7, domain: 'estimation', outcome: 'failure' }),
      makeDecision({ id: 8, domain: 'estimation', outcome: 'failure' }),
    ]);

    const handlers = await getHandlers();
    const result = await handlers['trust_report']({});

    const text = result.content[0].text;
    expect(text).toContain('2 domain(s)');
    expect(text).toContain('code-review');
    expect(text).toContain('estimation');
    expect(text).toContain('HIGH');
    expect(text).toContain('LOW');
  });
});

describe('Quality Ratchet — tool registration', () => {
  it('registers both tools', async () => {
    const tools: string[] = [];
    const mockServer = {
      tool: (...args: unknown[]) => {
        tools.push(args[0] as string);
      },
    };

    const { registerQualityRatchetTools } = await import('./quality-ratchet.js');
    registerQualityRatchetTools(mockServer as never);

    expect(tools).toContain('trust_report');
    expect(tools).toContain('trust_record');
    expect(tools).toHaveLength(2);
  });
});
