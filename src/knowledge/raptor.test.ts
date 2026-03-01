import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    knowledgeDir: '/tmp/test-knowledge',
  })),
}));

vi.mock('../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(),
}));

vi.mock('../models/router.js', () => ({
  getRoute: vi.fn(() => ({ model: 'claude-haiku-4-5-20251001', maxTokens: 256 })),
  calculateCost: vi.fn(() => 0.001),
}));

vi.mock('../models/token-tracker.js', () => ({
  trackUsage: vi.fn(),
}));

vi.mock('./fts-index.js', () => ({
  searchFts: vi.fn(),
  isFtsAvailable: vi.fn(),
}));

vi.mock('../utils/retry.js', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { readFileSync, existsSync } from 'fs';
import { getAnthropicClient } from '../config/anthropic.js';
import { isFtsAvailable, searchFts } from './fts-index.js';
import type { RaptorSummaries } from './raptor.js';

const MOCK_SUMMARIES: RaptorSummaries = {
  generatedAt: new Date().toISOString(),
  totalEntries: 25,
  totalClusters: 3,
  costUsd: 0.005,
  clusters: [
    { id: 'cluster-security', label: 'Security', domain: 'security', entryCount: 10, entries: [], summary: 'CSRF, auth, and RLS patterns.' },
    { id: 'cluster-database', label: 'Database', domain: 'database', entryCount: 8, entries: [], summary: 'Prisma migrations and enum rules.' },
    { id: 'cluster-workflow', label: 'Workflow', domain: 'workflow', entryCount: 7, entries: [], summary: 'Sprint tracking patterns.' },
  ],
  domains: [
    { name: 'security', clusterCount: 1, entryCount: 10, overview: 'Security requires CSRF headers and getUser auth.' },
    { name: 'database', clusterCount: 1, entryCount: 8, overview: 'Database uses Prisma with manual migrations.' },
    { name: 'workflow', clusterCount: 1, entryCount: 7, overview: 'Workflow tracks sprints with compound learning.' },
  ],
};

describe('raptor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('formatRaptorReport', () => {
    it('formats summaries into readable report', async () => {
      const { formatRaptorReport } = await import('./raptor.js');
      const report = formatRaptorReport(MOCK_SUMMARIES);

      expect(report).toContain('RAPTOR Knowledge Summaries');
      expect(report).toContain('Entries:** 25');
      expect(report).toContain('Clusters:** 3');
      expect(report).toContain('$0.0050');
      expect(report).toContain('Domain Overviews');
      expect(report).toContain('Security');
      expect(report).toContain('Database');
      expect(report).toContain('Workflow');
      expect(report).toContain('Cluster Details');
    });

    it('sorts domains by entry count descending', async () => {
      const { formatRaptorReport } = await import('./raptor.js');
      const report = formatRaptorReport(MOCK_SUMMARIES);

      const securityIdx = report.indexOf('security');
      const workflowIdx = report.indexOf('workflow');
      // security (10 entries) should appear before workflow (7 entries)
      expect(securityIdx).toBeLessThan(workflowIdx);
    });
  });

  describe('isSummaryStale', () => {
    it('returns true when no summaries file exists', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const { isSummaryStale } = await import('./raptor.js');
      expect(isSummaryStale()).toBe(true);
    });

    it('returns false when summaries are fresh', async () => {
      const fresh = { ...MOCK_SUMMARIES, generatedAt: new Date().toISOString() };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(fresh));

      const { isSummaryStale } = await import('./raptor.js');
      expect(isSummaryStale(7)).toBe(false);
    });

    it('returns true when summaries are stale', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);
      const stale = { ...MOCK_SUMMARIES, generatedAt: oldDate.toISOString() };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(stale));

      const { isSummaryStale } = await import('./raptor.js');
      expect(isSummaryStale(7)).toBe(true);
    });
  });

  describe('getDomainOverview', () => {
    it('returns overview for existing domain', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(MOCK_SUMMARIES));

      const { getDomainOverview } = await import('./raptor.js');
      const overview = getDomainOverview('security');
      expect(overview).toBe('Security requires CSRF headers and getUser auth.');
    });

    it('returns null for non-existent domain', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(MOCK_SUMMARIES));

      const { getDomainOverview } = await import('./raptor.js');
      expect(getDomainOverview('nonexistent')).toBeNull();
    });

    it('returns null when no summaries file', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const { getDomainOverview } = await import('./raptor.js');
      expect(getDomainOverview('security')).toBeNull();
    });
  });

  describe('getRaptorSummaries', () => {
    it('returns cached summaries', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(MOCK_SUMMARIES));

      const { getRaptorSummaries } = await import('./raptor.js');
      const result = getRaptorSummaries();
      expect(result).not.toBeNull();
      expect(result?.totalEntries).toBe(25);
    });

    it('returns null when no file exists', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const { getRaptorSummaries } = await import('./raptor.js');
      expect(getRaptorSummaries()).toBeNull();
    });
  });

  describe('buildRaptorSummaries', () => {
    it('returns empty summaries when FTS is unavailable', async () => {
      vi.mocked(isFtsAvailable).mockReturnValue(false);

      const { buildRaptorSummaries } = await import('./raptor.js');
      const result = await buildRaptorSummaries();
      expect(result.totalEntries).toBe(0);
      expect(result.clusters).toHaveLength(0);
      expect(result.domains).toHaveLength(0);
    });

    it('builds summaries from FTS entries via Haiku', async () => {
      vi.mocked(isFtsAvailable).mockReturnValue(true);
      vi.mocked(searchFts).mockReturnValue([
        { id: 'e1', source: 'patterns', sourceId: 1, text: 'Always use CSRF headers for auth security', date: '2026-02-01', ftsScore: 1, combinedScore: 1 },
        { id: 'e2', source: 'lessons', sourceId: 2, text: 'Prisma migration must split enum changes', date: '2026-02-01', ftsScore: 0.9, combinedScore: 0.9 },
      ]);
      vi.mocked(existsSync).mockReturnValue(false);

      const mockCreate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Summary of domain patterns.' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      vi.mocked(getAnthropicClient).mockReturnValue({
        messages: { create: mockCreate },
      } as unknown as ReturnType<typeof getAnthropicClient>);

      const { buildRaptorSummaries } = await import('./raptor.js');
      const result = await buildRaptorSummaries();

      expect(result.totalEntries).toBeGreaterThan(0);
      expect(result.clusters.length).toBeGreaterThan(0);
      expect(result.domains.length).toBeGreaterThan(0);
      expect(mockCreate).toHaveBeenCalled();
    });
  });
});
