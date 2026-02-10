import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

// Mock fs operations
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Need to reset modules between tests due to module-level mutable state
let trackUsage: typeof import('./token-tracker.js').trackUsage;
let getTodaySummary: typeof import('./token-tracker.js').getTodaySummary;
let initTokenTracker: typeof import('./token-tracker.js').initTokenTracker;
let cleanupOldUsageLogs: typeof import('./token-tracker.js').cleanupOldUsageLogs;
let checkCostThreshold: typeof import('./token-tracker.js').checkCostThreshold;

async function reloadModule() {
  vi.resetModules();
  const mod = await import('./token-tracker.js');
  trackUsage = mod.trackUsage;
  getTodaySummary = mod.getTodaySummary;
  initTokenTracker = mod.initTokenTracker;
  cleanupOldUsageLogs = mod.cleanupOldUsageLogs;
  checkCostThreshold = mod.checkCostThreshold;
}

describe('Token Tracker', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('');
    vi.mocked(readdirSync).mockReturnValue([]);
    await reloadModule();
  });

  describe('initTokenTracker', () => {
    it('creates usage directory if it does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      initTokenTracker();

      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('usage-logs'),
        { recursive: true }
      );
    });

    it('skips directory creation if already exists', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('');
      initTokenTracker();

      expect(mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe('trackUsage', () => {
    it('writes JSONL with correct fields', () => {
      initTokenTracker();
      const usage = trackUsage(
        'claude-haiku-4-5-20251001',
        1000,
        500,
        'briefing',
        'daily_briefing'
      );

      expect(appendFileSync).toHaveBeenCalledTimes(1);
      const [, writtenData] = vi.mocked(appendFileSync).mock.calls[0] as [string, string];
      const parsed = JSON.parse(writtenData.trim());

      expect(parsed.model).toBe('claude-haiku-4-5-20251001');
      expect(parsed.inputTokens).toBe(1000);
      expect(parsed.outputTokens).toBe(500);
      expect(parsed.taskType).toBe('briefing');
      expect(parsed.toolName).toBe('daily_briefing');
      expect(parsed.timestamp).toBeTruthy();
      expect(parsed.costUsd).toBeGreaterThan(0);
    });

    it('calculates cost correctly using router pricing', () => {
      initTokenTracker();
      // Haiku: input $0.80/1M, output $4/1M
      // 1000 input = 0.0008, 500 output = 0.002
      const usage = trackUsage('claude-haiku-4-5-20251001', 1000, 500, 'briefing');
      expect(usage.costUsd).toBe(0.00280);
    });

    it('returns usage object with all fields', () => {
      initTokenTracker();
      const usage = trackUsage('claude-sonnet-4-5-20250929', 2000, 1000, 'conversation', 'social_tool');

      expect(usage.model).toBe('claude-sonnet-4-5-20250929');
      expect(usage.inputTokens).toBe(2000);
      expect(usage.outputTokens).toBe(1000);
      expect(usage.taskType).toBe('conversation');
      expect(usage.toolName).toBe('social_tool');
      expect(usage.timestamp).toBeInstanceOf(Date);
    });

    it('handles cache token fields', () => {
      initTokenTracker();
      const usage = trackUsage('claude-haiku-4-5-20251001', 1000, 500, 'briefing', undefined, 200, 100);

      expect(usage.cacheReadTokens).toBe(200);
      expect(usage.cacheWriteTokens).toBe(100);
    });
  });

  describe('getTodaySummary', () => {
    it('returns zero totals when no usage recorded', () => {
      initTokenTracker();
      const summary = getTodaySummary();

      expect(summary.totalCostUsd).toBe(0);
      expect(summary.totalInputTokens).toBe(0);
      expect(summary.totalOutputTokens).toBe(0);
      expect(summary.period).toBe('daily');
    });

    it('returns correct totals for multiple entries', () => {
      initTokenTracker();
      trackUsage('claude-haiku-4-5-20251001', 1000, 500, 'briefing');
      trackUsage('claude-sonnet-4-5-20250929', 2000, 1000, 'conversation');

      const summary = getTodaySummary();

      expect(summary.totalInputTokens).toBe(3000);
      expect(summary.totalOutputTokens).toBe(1500);
      expect(summary.totalCostUsd).toBeGreaterThan(0);
    });

    it('aggregates byModel correctly', () => {
      initTokenTracker();
      trackUsage('claude-haiku-4-5-20251001', 1000, 500, 'briefing');
      trackUsage('claude-haiku-4-5-20251001', 2000, 1000, 'briefing');
      trackUsage('claude-sonnet-4-5-20250929', 500, 200, 'conversation');

      const summary = getTodaySummary();

      expect(summary.byModel['claude-haiku-4-5-20251001'].calls).toBe(2);
      expect(summary.byModel['claude-sonnet-4-5-20250929'].calls).toBe(1);
    });

    it('aggregates byTaskType correctly', () => {
      initTokenTracker();
      trackUsage('claude-haiku-4-5-20251001', 1000, 500, 'briefing');
      trackUsage('claude-sonnet-4-5-20250929', 2000, 1000, 'conversation');
      trackUsage('claude-sonnet-4-5-20250929', 500, 200, 'conversation');

      const summary = getTodaySummary();

      expect(summary.byTaskType['briefing'].calls).toBe(1);
      expect(summary.byTaskType['conversation'].calls).toBe(2);
    });
  });

  describe('cleanupOldUsageLogs', () => {
    it('deletes files older than retention period', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue([
        'usage-2020-01-01.jsonl' as unknown as ReturnType<typeof readdirSync>[0],
        'usage-2020-06-15.jsonl' as unknown as ReturnType<typeof readdirSync>[0],
      ]);

      initTokenTracker();
      cleanupOldUsageLogs(90);

      expect(unlinkSync).toHaveBeenCalledTimes(2);
    });

    it('keeps recent files', () => {
      const today = new Date().toISOString().split('T')[0];
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue([
        `usage-${today}.jsonl` as unknown as ReturnType<typeof readdirSync>[0],
      ]);

      initTokenTracker();
      cleanupOldUsageLogs(90);

      expect(unlinkSync).not.toHaveBeenCalled();
    });

    it('ignores non-usage files', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue([
        'readme.md' as unknown as ReturnType<typeof readdirSync>[0],
        'other-file.txt' as unknown as ReturnType<typeof readdirSync>[0],
      ]);

      initTokenTracker();
      cleanupOldUsageLogs(90);

      expect(unlinkSync).not.toHaveBeenCalled();
    });

    it('handles missing usage directory gracefully', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      initTokenTracker();
      expect(() => cleanupOldUsageLogs(90)).not.toThrow();
    });
  });

  describe('checkCostThreshold', () => {
    it('returns ok when cost is below warn threshold', () => {
      initTokenTracker();
      // Small usage — well below $5
      trackUsage('claude-haiku-4-5-20251001', 100, 50, 'briefing');

      const alert = checkCostThreshold();

      expect(alert.level).toBe('ok');
      expect(alert.message).toContain('OK');
    });

    it('returns warn when cost exceeds $5', () => {
      initTokenTracker();
      // Opus: $5/1M input + $25/1M output
      // 1M input = $5, so need just over that
      trackUsage('claude-opus-4-6', 1_100_000, 0, 'architecture');

      const alert = checkCostThreshold();

      expect(alert.level).toBe('warn');
      expect(alert.message).toContain('WARNING');
    });

    it('returns critical when cost exceeds $15', () => {
      initTokenTracker();
      // Opus: $5/1M input + $25/1M output
      // Need $15+: 3M input tokens = $15
      trackUsage('claude-opus-4-6', 3_100_000, 0, 'architecture');

      const alert = checkCostThreshold();

      expect(alert.level).toBe('critical');
      expect(alert.message).toContain('CRITICAL');
    });

    it('supports custom thresholds', () => {
      initTokenTracker();
      // Small usage
      trackUsage('claude-haiku-4-5-20251001', 1000, 500, 'briefing');

      // Set very low thresholds
      const alert = checkCostThreshold(0.001, 0.01);

      expect(alert.level).toBe('warn');
    });

    it('includes dailyCost and threshold in result', () => {
      initTokenTracker();
      const alert = checkCostThreshold(5, 15);

      expect(alert.dailyCost).toBeGreaterThanOrEqual(0);
      expect(alert.threshold).toBe(5);
    });
  });
});
