import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';

vi.mock('fs', () => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    radlOpsDir: '/tmp/test-ops',
    knowledgeDir: '/tmp/test-knowledge',
  })),
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '1. Fix rate limiting\n2. Add retries\n3. Improve error handling' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    },
  })),
}));

vi.mock('../../models/router.js', () => ({
  getRoute: vi.fn(() => ({ model: 'claude-haiku-4-5-20251001', maxTokens: 1000 })),
  calculateCost: vi.fn(() => 0.002),
}));

vi.mock('../../models/token-tracker.js', () => ({
  trackUsage: vi.fn(),
}));

vi.mock('../../utils/retry.js', () => ({
  withRetry: vi.fn((fn: Function) => fn()),
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

describe('failure-analysis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('classifyFailure (via runFailureAnalysis)', () => {
    // We test classification indirectly through parseWatcherLogs + runFailureAnalysis
    // because classifyFailure is not exported. We set up log files with specific error lines.

    it('classifies git errors', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(['2026-02-28-issue-100.log'] as any);
      vi.mocked(readFileSync).mockReturnValue('FAILED: fatal: merge conflict detected\n');

      const { runFailureAnalysis } = await import('./failure-analysis.js');
      const report = await runFailureAnalysis(7);

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].type).toBe('git');
    });

    it('classifies typecheck errors', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(['2026-02-28-issue-101.log'] as any);
      vi.mocked(readFileSync).mockReturnValue('ERROR: error TS2304: Cannot find name "foo"\n');

      const { runFailureAnalysis } = await import('./failure-analysis.js');
      const report = await runFailureAnalysis(7);

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].type).toBe('typecheck');
    });

    it('classifies timeout messages', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(['2026-02-28-issue-102.log'] as any);
      vi.mocked(readFileSync).mockReturnValue('FAILED: WATCHER_TIMEOUT exceeded\n');

      const { runFailureAnalysis } = await import('./failure-analysis.js');
      const report = await runFailureAnalysis(7);

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].type).toBe('timeout');
    });

    it('classifies claude API errors', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(['2026-02-28-issue-103.log'] as any);
      vi.mocked(readFileSync).mockReturnValue('ERROR: claude API error 529 overloaded\n');

      const { runFailureAnalysis } = await import('./failure-analysis.js');
      const report = await runFailureAnalysis(7);

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].type).toBe('claude_error');
    });

    it('classifies unrecognized messages as unknown', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(['2026-02-28-issue-104.log'] as any);
      vi.mocked(readFileSync).mockReturnValue('FAILED: something completely unexpected happened\n');

      const { runFailureAnalysis } = await import('./failure-analysis.js');
      const report = await runFailureAnalysis(7);

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].type).toBe('unknown');
    });
  });

  describe('parseWatcherLogs (via runFailureAnalysis)', () => {
    it('returns empty when logs directory does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const { runFailureAnalysis } = await import('./failure-analysis.js');
      const report = await runFailureAnalysis(7);

      expect(report.entries).toHaveLength(0);
      expect(report.totalFailures).toBe(0);
    });

    it('filters files by date cutoff', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      // Old file should be excluded (more than 7 days ago)
      vi.mocked(readdirSync).mockReturnValue([
        '2020-01-01-issue-1.log',  // very old, should be filtered
        '2026-02-28-issue-2.log',  // recent, should be included
      ] as any);
      vi.mocked(readFileSync).mockReturnValue('FAILED: some error\n');

      const { runFailureAnalysis } = await import('./failure-analysis.js');
      const report = await runFailureAnalysis(7);

      // Only the recent file should produce entries
      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].issueNum).toBe(2);
    });

    it('extracts issue numbers from filenames', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(['2026-02-28-issue-42.log'] as any);
      vi.mocked(readFileSync).mockReturnValue('FAILED: git push error\n');

      const { runFailureAnalysis } = await import('./failure-analysis.js');
      const report = await runFailureAnalysis(7);

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].issueNum).toBe(42);
      expect(report.entries[0].logFile).toBe('2026-02-28-issue-42.log');
    });

    it('classifies failure lines within log files', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(['2026-02-28-issue-10.log'] as any);
      vi.mocked(readFileSync).mockReturnValue(
        'FAILED: fatal: git push rejected\n' +
        'ERROR: error TS2345 type mismatch\n'
      );

      const { runFailureAnalysis } = await import('./failure-analysis.js');
      const report = await runFailureAnalysis(7);

      expect(report.entries).toHaveLength(2);
      expect(report.entries[0].type).toBe('git');
      expect(report.entries[1].type).toBe('typecheck');
    });

    it('skips debug and info lines', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(['2026-02-28-issue-20.log'] as any);
      vi.mocked(readFileSync).mockReturnValue(
        'debug: FAILED to connect to something\n' +
        'info: ERROR message from logger\n' +
        'FAILED: real error that should be captured\n'
      );

      const { runFailureAnalysis } = await import('./failure-analysis.js');
      const report = await runFailureAnalysis(7);

      // Only the last line should be captured (first two start with debug/info)
      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].message).toContain('real error');
    });

    it('skips non-.log files', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue([
        '2026-02-28-issue-50.txt',  // not a .log file
        '2026-02-28-issue-51.log',  // valid
      ] as any);
      vi.mocked(readFileSync).mockReturnValue('FAILED: some error\n');

      const { runFailureAnalysis } = await import('./failure-analysis.js');
      const report = await runFailureAnalysis(7);

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].issueNum).toBe(51);
    });

    it('handles issue number 0 when filename has no issue pattern', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(['2026-02-28-general.log'] as any);
      vi.mocked(readFileSync).mockReturnValue('FAILED: something broke\n');

      const { runFailureAnalysis } = await import('./failure-analysis.js');
      const report = await runFailureAnalysis(7);

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].issueNum).toBe(0);
    });
  });

  describe('runFailureAnalysis', () => {
    it('returns empty report with zero cost when no failures found', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue([] as any);

      const { runFailureAnalysis } = await import('./failure-analysis.js');
      const report = await runFailureAnalysis(7);

      expect(report.totalFailures).toBe(0);
      expect(report.entries).toHaveLength(0);
      expect(report.analysis).toContain('No failures found');
      expect(report.recommendations).toHaveLength(0);
      expect(report.costUsd).toBe(0);
    });

    it('includes period in the report', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const { runFailureAnalysis } = await import('./failure-analysis.js');
      const report = await runFailureAnalysis(7);

      expect(report.period).toMatch(/\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/);
    });

    it('groups failures by type in byType field', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue([
        '2026-02-28-issue-1.log',
        '2026-02-28-issue-2.log',
      ] as any);

      let callCount = 0;
      vi.mocked(readFileSync).mockImplementation(() => {
        callCount++;
        if (callCount === 1) return 'FAILED: fatal: git push rejected\n';
        return 'FAILED: fatal: git merge conflict\nERROR: timed out waiting\n';
      });

      const { runFailureAnalysis } = await import('./failure-analysis.js');
      const report = await runFailureAnalysis(7);

      expect(report.byType['git']).toBe(2);
      expect(report.byType['timeout']).toBe(1);
      expect(report.totalFailures).toBe(3);
    });

    it('calls AI analysis and returns recommendations when failures exist', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(['2026-02-28-issue-5.log'] as any);
      vi.mocked(readFileSync).mockReturnValue('FAILED: fatal: git push failed\n');

      const { runFailureAnalysis } = await import('./failure-analysis.js');
      const report = await runFailureAnalysis(7);

      expect(report.totalFailures).toBe(1);
      expect(report.analysis).toBeTruthy();
      expect(report.costUsd).toBeGreaterThan(0);
    });
  });

  describe('registerFailureAnalysisTools', () => {
    it('registers the weekly_failure_analysis tool on the server', async () => {
      const mockTool = vi.fn();
      const mockServer = { tool: mockTool } as any;

      const { registerFailureAnalysisTools } = await import('./failure-analysis.js');
      registerFailureAnalysisTools(mockServer);

      expect(mockTool).toHaveBeenCalledTimes(1);
      expect(mockTool).toHaveBeenCalledWith(
        'weekly_failure_analysis',
        expect.any(String),
        expect.objectContaining({
          days_back: expect.anything(),
        }),
        expect.objectContaining({
          readOnlyHint: true,
          destructiveHint: false,
        }),
        expect.any(Function),
      );
    });

    it('handler returns clean message when no failures found', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const handlers: Record<string, Function> = {};
      const mockServer = {
        tool: (...args: unknown[]) => {
          const name = args[0] as string;
          handlers[name] = args[args.length - 1] as Function;
        },
      };

      const { registerFailureAnalysisTools } = await import('./failure-analysis.js');
      registerFailureAnalysisTools(mockServer as any);

      const result = await handlers['weekly_failure_analysis']({ days_back: 7 });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('No failures found');
      expect(result.content[0].text).toContain('running cleanly');
    });

    it('handler returns formatted report when failures exist', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(['2026-02-28-issue-99.log'] as any);
      vi.mocked(readFileSync).mockReturnValue('FAILED: fatal: git conflict\n');

      const handlers: Record<string, Function> = {};
      const mockServer = {
        tool: (...args: unknown[]) => {
          const name = args[0] as string;
          handlers[name] = args[args.length - 1] as Function;
        },
      };

      const { registerFailureAnalysisTools } = await import('./failure-analysis.js');
      registerFailureAnalysisTools(mockServer as any);

      const result = await handlers['weekly_failure_analysis']({ days_back: 7 });
      const text = result.content[0].text;

      expect(text).toContain('Weekly Failure Analysis');
      expect(text).toContain('Total failures');
      expect(text).toContain('By Type');
      expect(text).toContain('Recent Failures');
      expect(text).toContain('Analysis');
    });
  });
});
