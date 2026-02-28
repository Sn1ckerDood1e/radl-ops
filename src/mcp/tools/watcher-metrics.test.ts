import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    radlOpsDir: '/tmp/test-ops',
  })),
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

vi.mock('../../knowledge/prompt-registry.js', () => ({
  getPromptVersions: vi.fn(() => []),
  formatVersionReport: vi.fn(() => 'No prompt versions registered.'),
}));

import { computeAutonomyIndex } from './watcher-metrics.js';

describe('watcher-metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('computeAutonomyIndex', () => {
    it('returns 0 for 0/0', () => {
      expect(computeAutonomyIndex({ succeeded: 0, total: 0 })).toBe(0);
    });

    it('returns 0.5 for 5/10', () => {
      expect(computeAutonomyIndex({ succeeded: 5, total: 10 })).toBe(0.5);
    });

    it('returns 1.0 for 3/3', () => {
      expect(computeAutonomyIndex({ succeeded: 3, total: 3 })).toBe(1);
    });

    it('returns 0 for 0/5', () => {
      expect(computeAutonomyIndex({ succeeded: 0, total: 5 })).toBe(0);
    });

    it('rounds to 2 decimal places', () => {
      // 7/11 = 0.636363... → rounded to 0.64
      expect(computeAutonomyIndex({ succeeded: 7, total: 11 })).toBe(0.64);
    });
  });

  describe('MCP handler', () => {
    it('returns empty metrics when no logs directory', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      // Import the module to test the handler indirectly through registration
      const { registerWatcherMetricsTools } = await import('./watcher-metrics.js');

      let capturedHandler: Function | null = null;
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          // The handler is the last argument
          capturedHandler = args[args.length - 1] as Function;
        }),
      };

      registerWatcherMetricsTools(mockServer as never);
      expect(capturedHandler).not.toBeNull();

      const result = await capturedHandler!({ days_back: 30 });
      expect(result.content[0].text).toContain('Total issues:** 0');
      expect(result.content[0].text).toContain('Pass@1:** 0%');
    });

    it('computes metrics from mixed success/failure logs', async () => {
      const { existsSync, readdirSync, readFileSync } = await import('fs');

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue([
        '2026-02-25-issue-10.log',
        '2026-02-26-issue-11.log',
        '2026-02-27-issue-12.log',
      ] as unknown as ReturnType<typeof readdirSync>);

      vi.mocked(readFileSync).mockImplementation((path: unknown) => {
        const p = String(path);
        if (p.includes('cost-summary')) {
          return '{"date":"2026-02-25","issue":10,"cost_usd":0.05}\n{"date":"2026-02-26","issue":11,"cost_usd":0.03}\n{"date":"2026-02-27","issue":12,"cost_usd":0.04}';
        }
        if (p.includes('issue-10')) {
          return '[2026-02-25 10:00:00] Starting\n[2026-02-25 10:05:00] PR created\n';
        }
        if (p.includes('issue-11')) {
          return '[2026-02-26 11:00:00] Starting\n[2026-02-26 11:10:00] FAILED: typecheck error\n';
        }
        if (p.includes('issue-12')) {
          return '[2026-02-27 12:00:00] Starting\n[2026-02-27 12:03:00] gh pr create success\n';
        }
        return '';
      });

      const { registerWatcherMetricsTools } = await import('./watcher-metrics.js');

      let capturedHandler: Function | null = null;
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          capturedHandler = args[args.length - 1] as Function;
        }),
      };

      registerWatcherMetricsTools(mockServer as never);
      const result = await capturedHandler!({ days_back: 30 });
      const text = result.content[0].text;

      expect(text).toContain('Total issues:** 3');
      expect(text).toContain('Watcher Metrics');
    });

    it('includes failure type breakdown', async () => {
      const { existsSync, readdirSync, readFileSync } = await import('fs');

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue([
        '2026-02-25-issue-20.log',
        '2026-02-26-issue-21.log',
      ] as unknown as ReturnType<typeof readdirSync>);

      vi.mocked(readFileSync).mockImplementation((path: unknown) => {
        const p = String(path);
        if (p.includes('cost-summary')) return '';
        if (p.includes('issue-20')) {
          return '[2026-02-25 10:00:00] TIMEOUT: timed out after 2h\n';
        }
        if (p.includes('issue-21')) {
          return '[2026-02-26 11:00:00] FAILED: tsc error in src/a.ts\ntypecheck error\n';
        }
        return '';
      });

      const { registerWatcherMetricsTools } = await import('./watcher-metrics.js');

      let capturedHandler: Function | null = null;
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          capturedHandler = args[args.length - 1] as Function;
        }),
      };

      registerWatcherMetricsTools(mockServer as never);
      const result = await capturedHandler!({ days_back: 30 });
      const text = result.content[0].text;

      expect(text).toContain('Failures by Type');
      expect(text).toContain('timeout');
    });

    it('shows daily trend', async () => {
      const { existsSync, readdirSync, readFileSync } = await import('fs');

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue([
        '2026-02-25-issue-30.log',
        '2026-02-25-issue-31.log',
      ] as unknown as ReturnType<typeof readdirSync>);

      vi.mocked(readFileSync).mockImplementation((path: unknown) => {
        const p = String(path);
        if (p.includes('cost-summary')) return '';
        if (p.includes('issue-30')) {
          return '[2026-02-25 10:00:00] Starting\n[2026-02-25 10:05:00] PR created\n';
        }
        if (p.includes('issue-31')) {
          return '[2026-02-25 11:00:00] Starting\n[2026-02-25 11:05:00] PR created\n';
        }
        return '';
      });

      const { registerWatcherMetricsTools } = await import('./watcher-metrics.js');

      let capturedHandler: Function | null = null;
      const mockServer = {
        tool: vi.fn((...args: unknown[]) => {
          capturedHandler = args[args.length - 1] as Function;
        }),
      };

      registerWatcherMetricsTools(mockServer as never);
      const result = await capturedHandler!({ days_back: 30 });
      const text = result.content[0].text;

      expect(text).toContain('Daily Trend');
      expect(text).toContain('2026-02-25');
      expect(text).toContain('100%');
    });
  });
});
