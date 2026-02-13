import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

const mockGetTodaySummary = vi.fn();
const mockGetCostSummaryForBriefing = vi.fn();
const mockCheckCostThreshold = vi.fn();
const mockGetCurrentSprintPhase = vi.fn();

vi.mock('../../models/token-tracker.js', () => ({
  getTodaySummary: () => mockGetTodaySummary(),
  getCostSummaryForBriefing: () => mockGetCostSummaryForBriefing(),
  checkCostThreshold: () => mockCheckCostThreshold(),
  getCurrentSprintPhase: () => mockGetCurrentSprintPhase(),
}));

// Extract handler by registering with a mock server
async function getHandler() {
  const handlers: Record<string, Function> = {};
  const mockServer = {
    tool: (...args: unknown[]) => {
      const name = args[0] as string;
      handlers[name] = args[args.length - 1] as Function;
    },
  };

  const { registerCostTools } = await import('./costs.js');
  registerCostTools(mockServer as any);
  return handlers['cost_report'];
}

describe('Cost Report Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock values
    mockGetTodaySummary.mockReturnValue({
      totalCalls: 42,
      totalInputTokens: 10000,
      totalOutputTokens: 5000,
      totalCostUsd: 0.25,
      totalCacheReadTokens: 2000,
      totalCacheWriteTokens: 500,
      estimatedCacheSavingsUsd: 0.05,
      bySprint: {
        'Phase 60': { calls: 20, costUsd: 0.12 },
        'Phase 61': { calls: 15, costUsd: 0.08 },
        'untagged': { calls: 7, costUsd: 0.05 },
      },
    });

    mockGetCostSummaryForBriefing.mockReturnValue(
      '**Today**: 42 calls, $0.25 (cache: $0.05 saved)'
    );

    mockCheckCostThreshold.mockReturnValue({
      level: 'ok',
      message: '',
    });

    mockGetCurrentSprintPhase.mockReturnValue('Phase 62');
  });

  describe('summary format', () => {
    it('returns text summary with cost breakdown', async () => {
      const handler = await getHandler();
      const result = await handler({ format: 'summary' });
      const text = result.content[0].text;

      expect(text).toContain('**Today**: 42 calls, $0.25');
      expect(text).toContain('cache: $0.05 saved');
    });

    it('includes by-sprint breakdown when available', async () => {
      const handler = await getHandler();
      const result = await handler({ format: 'summary' });
      const text = result.content[0].text;

      expect(text).toContain('**By Sprint:**');
      expect(text).toContain('Phase 60: 20 calls, $0.12');
      expect(text).toContain('Phase 61: 15 calls, $0.08');
    });

    it('excludes untagged from sprint breakdown', async () => {
      const handler = await getHandler();
      const result = await handler({ format: 'summary' });
      const text = result.content[0].text;

      expect(text).not.toContain('untagged:');
    });

    it('includes active sprint when available', async () => {
      const handler = await getHandler();
      const result = await handler({ format: 'summary' });
      const text = result.content[0].text;

      expect(text).toContain('_Active sprint: Phase 62_');
    });

    it('omits active sprint section when no sprint is running', async () => {
      mockGetCurrentSprintPhase.mockReturnValue(null);

      const handler = await getHandler();
      const result = await handler({ format: 'summary' });
      const text = result.content[0].text;

      expect(text).not.toContain('_Active sprint:');
    });

    it('appends alert when threshold exceeded', async () => {
      mockCheckCostThreshold.mockReturnValue({
        level: 'warning',
        message: 'Daily spend approaching limit ($0.25 of $0.30)',
      });

      const handler = await getHandler();
      const result = await handler({ format: 'summary' });
      const text = result.content[0].text;

      expect(text).toContain('**WARNING**: Daily spend approaching limit');
    });

    it('does not append alert when level is ok', async () => {
      mockCheckCostThreshold.mockReturnValue({
        level: 'ok',
        message: '',
      });

      const handler = await getHandler();
      const result = await handler({ format: 'summary' });
      const text = result.content[0].text;

      expect(text).not.toContain('**WARNING**');
      expect(text).not.toContain('**CRITICAL**');
    });
  });

  describe('detailed format', () => {
    it('returns JSON with full analytics', async () => {
      const handler = await getHandler();
      const result = await handler({ format: 'detailed' });
      const text = result.content[0].text;

      const data = JSON.parse(text);
      expect(data.totalCalls).toBe(42);
      expect(data.totalCostUsd).toBe(0.25);
      expect(data.bySprint).toHaveProperty('Phase 60');
      expect(data.bySprint).toHaveProperty('Phase 61');
    });

    it('includes cache metrics in structured format', async () => {
      const handler = await getHandler();
      const result = await handler({ format: 'detailed' });
      const text = result.content[0].text;

      const data = JSON.parse(text);
      expect(data.cache).toEqual({
        readTokens: 2000,
        writeTokens: 500,
        estimatedSavingsUsd: 0.05,
      });
    });

    it('includes active sprint in JSON', async () => {
      const handler = await getHandler();
      const result = await handler({ format: 'detailed' });
      const text = result.content[0].text;

      const data = JSON.parse(text);
      expect(data.activeSprint).toBe('Phase 62');
    });

    it('includes alert in JSON', async () => {
      mockCheckCostThreshold.mockReturnValue({
        level: 'critical',
        message: 'Daily limit exceeded!',
      });

      const handler = await getHandler();
      const result = await handler({ format: 'detailed' });
      const text = result.content[0].text;

      const data = JSON.parse(text);
      expect(data.alert).toEqual({
        level: 'critical',
        message: 'Daily limit exceeded!',
      });
    });
  });

  describe('format parameter', () => {
    it('uses summary format when explicitly requested', async () => {
      const handler = await getHandler();
      const result = await handler({ format: 'summary' });
      const text = result.content[0].text;

      expect(text).toContain('**Today**: 42 calls');
      // Should not be JSON
      expect(() => JSON.parse(text)).toThrow();
    });
  });

  describe('edge cases', () => {
    it('handles empty sprint breakdown', async () => {
      mockGetTodaySummary.mockReturnValue({
        totalCalls: 10,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalCostUsd: 0.01,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        estimatedCacheSavingsUsd: 0,
        bySprint: {
          'untagged': { calls: 10, costUsd: 0.01 },
        },
      });

      const handler = await getHandler();
      const result = await handler({ format: 'summary' });
      const text = result.content[0].text;

      expect(text).not.toContain('**By Sprint:**');
    });

    it('handles zero calls', async () => {
      mockGetTodaySummary.mockReturnValue({
        totalCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        estimatedCacheSavingsUsd: 0,
        bySprint: {},
      });

      mockGetCostSummaryForBriefing.mockReturnValue('**Today**: 0 calls, $0.00');

      const handler = await getHandler();
      const result = await handler({ format: 'summary' });
      const text = result.content[0].text;

      expect(text).toContain('**Today**: 0 calls, $0.00');
    });

    it('handles missing cache data', async () => {
      mockGetTodaySummary.mockReturnValue({
        totalCalls: 10,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalCostUsd: 0.01,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        estimatedCacheSavingsUsd: 0,
        bySprint: {},
      });

      const handler = await getHandler();
      const result = await handler({ format: 'detailed' });
      const text = result.content[0].text;

      const data = JSON.parse(text);
      expect(data.cache.readTokens).toBe(0);
      expect(data.cache.writeTokens).toBe(0);
      expect(data.cache.estimatedSavingsUsd).toBe(0);
    });
  });
});
