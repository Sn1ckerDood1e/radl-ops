import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    knowledgeDir: '/tmp/test-knowledge',
  })),
}));

vi.mock('../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { readFileSync, writeFileSync, existsSync } from 'fs';

describe('prompt-registry', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function loadModule() {
    return import('./prompt-registry.js');
  }

  describe('registerPromptVersion', () => {
    it('registers a new version when none exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(writeFileSync).mockImplementation(() => {});

      const mod = await loadModule();
      const id = mod.registerPromptVersion('watcher-prompt', 'template content v1');

      expect(id).toHaveLength(12);
      expect(writeFileSync).toHaveBeenCalled();
      const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
      expect(written.versions).toHaveLength(1);
      expect(written.versions[0].template).toBe('watcher-prompt');
      expect(written.versions[0].version).toBe(1);
      expect(written.activeVersionId).toBe(id);
    });

    it('returns existing id when same content is registered', async () => {
      const existingRegistry = {
        versions: [{
          id: 'abc123def456',
          template: 'watcher-prompt',
          version: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          contentHash: '',
          metrics: { issuesProcessed: 0, successCount: 0, failureCount: 0, successRate: 0, avgCostUsd: 0, totalCostUsd: 0 },
        }],
        activeVersionId: 'abc123def456',
      };

      // We need the hash to match — compute it like the module does
      const { createHash } = await import('crypto');
      const hash = createHash('sha256').update('template content v1').digest('hex');
      existingRegistry.versions[0].contentHash = hash;
      existingRegistry.versions[0].id = hash.substring(0, 12);

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(existingRegistry));
      vi.mocked(writeFileSync).mockImplementation(() => {});

      const mod = await loadModule();
      const id = mod.registerPromptVersion('watcher-prompt', 'template content v1');
      expect(id).toBe(hash.substring(0, 12));
    });

    it('creates new version with incremented number for different content', async () => {
      const { createHash } = await import('crypto');
      const hash1 = createHash('sha256').update('content v1').digest('hex');

      const existingRegistry = {
        versions: [{
          id: hash1.substring(0, 12),
          template: 'watcher-prompt',
          version: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          contentHash: hash1,
          metrics: { issuesProcessed: 0, successCount: 0, failureCount: 0, successRate: 0, avgCostUsd: 0, totalCostUsd: 0 },
        }],
        activeVersionId: hash1.substring(0, 12),
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(existingRegistry));
      vi.mocked(writeFileSync).mockImplementation(() => {});

      const mod = await loadModule();
      const id = mod.registerPromptVersion('watcher-prompt', 'content v2');

      expect(id).not.toBe(hash1.substring(0, 12));
      const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
      expect(written.versions).toHaveLength(2);
      expect(written.versions[1].version).toBe(2);
    });
  });

  describe('recordIssueOutcome', () => {
    it('updates metrics for active version on success', async () => {
      const { createHash } = await import('crypto');
      const hash = createHash('sha256').update('template').digest('hex');
      const id = hash.substring(0, 12);

      const registry = {
        versions: [{
          id,
          template: 'watcher-prompt',
          version: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          contentHash: hash,
          metrics: { issuesProcessed: 5, successCount: 3, failureCount: 2, successRate: 0.6, avgCostUsd: 0.01, totalCostUsd: 0.05 },
        }],
        activeVersionId: id,
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(registry));
      vi.mocked(writeFileSync).mockImplementation(() => {});

      const mod = await loadModule();
      mod.recordIssueOutcome(true, 0.02);

      const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
      expect(written.versions[0].metrics.issuesProcessed).toBe(6);
      expect(written.versions[0].metrics.successCount).toBe(4);
      expect(written.versions[0].metrics.failureCount).toBe(2);
    });

    it('updates metrics for active version on failure', async () => {
      const { createHash } = await import('crypto');
      const hash = createHash('sha256').update('template').digest('hex');
      const id = hash.substring(0, 12);

      const registry = {
        versions: [{
          id,
          template: 'watcher-prompt',
          version: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          contentHash: hash,
          metrics: { issuesProcessed: 5, successCount: 3, failureCount: 2, successRate: 0.6, avgCostUsd: 0.01, totalCostUsd: 0.05 },
        }],
        activeVersionId: id,
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(registry));
      vi.mocked(writeFileSync).mockImplementation(() => {});

      const mod = await loadModule();
      mod.recordIssueOutcome(false, 0.03);

      const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
      expect(written.versions[0].metrics.issuesProcessed).toBe(6);
      expect(written.versions[0].metrics.successCount).toBe(3);
      expect(written.versions[0].metrics.failureCount).toBe(3);
    });

    it('does nothing when no active version', async () => {
      const registry = { versions: [], activeVersionId: null };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(registry));

      const mod = await loadModule();
      mod.recordIssueOutcome(true, 0.01);

      expect(writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('getPromptVersions', () => {
    it('returns all versions when no filter', async () => {
      const registry = {
        versions: [
          { id: 'aaa', template: 'watcher-prompt', version: 1, createdAt: '', contentHash: 'x', metrics: { issuesProcessed: 0, successCount: 0, failureCount: 0, successRate: 0, avgCostUsd: 0, totalCostUsd: 0 } },
          { id: 'bbb', template: 'other-prompt', version: 1, createdAt: '', contentHash: 'y', metrics: { issuesProcessed: 0, successCount: 0, failureCount: 0, successRate: 0, avgCostUsd: 0, totalCostUsd: 0 } },
        ],
        activeVersionId: 'aaa',
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(registry));

      const mod = await loadModule();
      const versions = mod.getPromptVersions();
      expect(versions).toHaveLength(2);
    });

    it('filters by template name', async () => {
      const registry = {
        versions: [
          { id: 'aaa', template: 'watcher-prompt', version: 1, createdAt: '', contentHash: 'x', metrics: { issuesProcessed: 0, successCount: 0, failureCount: 0, successRate: 0, avgCostUsd: 0, totalCostUsd: 0 } },
          { id: 'bbb', template: 'other-prompt', version: 1, createdAt: '', contentHash: 'y', metrics: { issuesProcessed: 0, successCount: 0, failureCount: 0, successRate: 0, avgCostUsd: 0, totalCostUsd: 0 } },
        ],
        activeVersionId: 'aaa',
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(registry));

      const mod = await loadModule();
      const versions = mod.getPromptVersions('watcher-prompt');
      expect(versions).toHaveLength(1);
      expect(versions[0].template).toBe('watcher-prompt');
    });
  });

  describe('getActiveVersionId', () => {
    it('returns active version id', async () => {
      const registry = { versions: [], activeVersionId: 'abc123' };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(registry));

      const mod = await loadModule();
      expect(mod.getActiveVersionId()).toBe('abc123');
    });

    it('returns null when no active version', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const mod = await loadModule();
      expect(mod.getActiveVersionId()).toBeNull();
    });
  });

  describe('formatVersionReport', () => {
    it('returns message when no versions', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const mod = await loadModule();
      const report = mod.formatVersionReport();
      expect(report).toBe('No prompt versions registered.');
    });

    it('formats populated version history', async () => {
      const registry = {
        versions: [{
          id: 'abc123def456',
          template: 'watcher-prompt',
          version: 2,
          createdAt: '2026-02-28T12:00:00.000Z',
          contentHash: 'fullhash',
          metrics: { issuesProcessed: 10, successCount: 8, failureCount: 2, successRate: 0.8, avgCostUsd: 0.015, totalCostUsd: 0.15 },
        }],
        activeVersionId: 'abc123def456',
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(registry));

      const mod = await loadModule();
      const report = mod.formatVersionReport('watcher-prompt');
      expect(report).toContain('Prompt Version History');
      expect(report).toContain('abc123def456');
      expect(report).toContain('ACTIVE');
      expect(report).toContain('v2');
      expect(report).toContain('Issues: 10');
      expect(report).toContain('80%');
    });
  });
});
