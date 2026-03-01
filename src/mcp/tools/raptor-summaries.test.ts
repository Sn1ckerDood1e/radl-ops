import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

vi.mock('../../knowledge/raptor.js', () => ({
  buildRaptorSummaries: vi.fn(),
  getRaptorSummaries: vi.fn(),
  isSummaryStale: vi.fn(),
  formatRaptorReport: vi.fn(),
}));

import {
  buildRaptorSummaries,
  getRaptorSummaries,
  isSummaryStale,
  formatRaptorReport,
} from '../../knowledge/raptor.js';
import type { RaptorSummaries } from '../../knowledge/raptor.js';
import { registerRaptorSummaryTools } from './raptor-summaries.js';

const MOCK_SUMMARIES: RaptorSummaries = {
  generatedAt: '2026-02-28T12:00:00.000Z',
  totalEntries: 25,
  totalClusters: 3,
  costUsd: 0.005,
  clusters: [],
  domains: [],
};

function setupHandler(): Function {
  let capturedHandler: Function | null = null;
  const mockServer = {
    tool: vi.fn((...args: unknown[]) => {
      capturedHandler = args[args.length - 1] as Function;
    }),
  };

  registerRaptorSummaryTools(mockServer as never);
  return capturedHandler!;
}

describe('raptor-summaries MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('view action', () => {
    it('reports no summaries when cache is null and stale', async () => {
      vi.mocked(getRaptorSummaries).mockReturnValue(null);
      vi.mocked(isSummaryStale).mockReturnValue(true);

      const handler = setupHandler();
      const result = await handler({ action: 'view' });

      expect(result.content[0].text).toContain('No RAPTOR summaries found');
      expect(result.content[0].text).toContain('rebuild');
    });

    it('reports no summaries when cache is null and fresh', async () => {
      vi.mocked(getRaptorSummaries).mockReturnValue(null);
      vi.mocked(isSummaryStale).mockReturnValue(false);

      const handler = setupHandler();
      const result = await handler({ action: 'view' });

      expect(result.content[0].text).toContain('No RAPTOR summaries available');
    });

    it('returns formatted report when cached and fresh', async () => {
      vi.mocked(getRaptorSummaries).mockReturnValue(MOCK_SUMMARIES);
      vi.mocked(isSummaryStale).mockReturnValue(false);
      vi.mocked(formatRaptorReport).mockReturnValue('## RAPTOR Report\nFormatted content');

      const handler = setupHandler();
      const result = await handler({ action: 'view' });

      expect(result.content[0].text).toContain('RAPTOR Report');
      expect(result.content[0].text).not.toContain('stale');
    });

    it('returns formatted report with stale warning when cached but old', async () => {
      vi.mocked(getRaptorSummaries).mockReturnValue(MOCK_SUMMARIES);
      vi.mocked(isSummaryStale).mockReturnValue(true);
      vi.mocked(formatRaptorReport).mockReturnValue('## RAPTOR Report\nFormatted content');

      const handler = setupHandler();
      const result = await handler({ action: 'view' });

      expect(result.content[0].text).toContain('RAPTOR Report');
      expect(result.content[0].text).toContain('stale');
      expect(result.content[0].text).toContain('rebuilding');
    });
  });

  describe('rebuild action', () => {
    it('rebuilds and returns formatted report with cost', async () => {
      vi.mocked(buildRaptorSummaries).mockResolvedValue(MOCK_SUMMARIES);
      vi.mocked(formatRaptorReport).mockReturnValue('## RAPTOR Report\nRebuilt content');

      const handler = setupHandler();
      const result = await handler({ action: 'rebuild' });

      expect(buildRaptorSummaries).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain('RAPTOR Report');
      expect(result.content[0].text).toContain('Rebuilt successfully');
      expect(result.content[0].text).toContain('$0.0050');
    });
  });
});
