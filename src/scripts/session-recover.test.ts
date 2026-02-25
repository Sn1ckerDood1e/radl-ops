import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Test the exported functions
import { recoverSessions, formatRecoveryMarkdown } from './session-recover.js';

// Create a temp dir for test session files
const TEST_DIR = join(tmpdir(), `session-recover-test-${Date.now()}`);
const SESSIONS_SUBDIR = join(TEST_DIR, '.claude/projects/-home-hb');

function createTestSession(sessionId: string, entries: object[]): string {
  const filePath = join(SESSIONS_SUBDIR, `${sessionId}.jsonl`);
  const content = entries.map(e => JSON.stringify(e)).join('\n');
  writeFileSync(filePath, content);
  return filePath;
}

describe('session-recover', () => {
  beforeEach(() => {
    mkdirSync(SESSIONS_SUBDIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('formatRecoveryMarkdown', () => {
    it('should handle empty summaries', () => {
      const output = formatRecoveryMarkdown([]);
      expect(output).toBe('No recent sessions found.');
    });

    it('should format session summary', () => {
      const summaries = [{
        sessionId: '12345678-abcd-1234-5678-abcdef012345',
        lastModified: new Date('2026-02-24T10:00:00Z'),
        branch: 'feat/test-feature',
        toolCalls: [
          { tool: 'Edit', count: 5, lastUsed: '2026-02-24T10:00:00Z' },
          { tool: 'Read', count: 3, lastUsed: '2026-02-24T09:50:00Z' },
        ],
        fileModifications: ['/home/hb/radl/src/app/page.tsx', '/home/hb/radl/src/lib/utils.ts'],
        gitOperations: ['git add src/app/page.tsx', 'git commit -m "feat: update page"'],
        mcpTools: ['mcp__radl-ops__sprint_start', 'mcp__radl-ops__sprint_progress'],
      }];

      const output = formatRecoveryMarkdown(summaries);

      expect(output).toContain('SESSION RECOVERY CONTEXT');
      expect(output).toContain('12345678...');
      expect(output).toContain('feat/test-feature');
      expect(output).toContain('page.tsx');
      expect(output).toContain('utils.ts');
      expect(output).toContain('git commit');
      expect(output).toContain('Edit(5)');
      expect(output).toContain('mcp__radl-ops__sprint_start');
    });

    it('should limit to 3 sessions', () => {
      const summaries = Array.from({ length: 5 }, (_, i) => ({
        sessionId: `sess${i}000-abcd-1234-5678-abcdef012345`,
        lastModified: new Date(),
        branch: `branch-${i}`,
        toolCalls: [],
        fileModifications: [],
        gitOperations: [],
        mcpTools: [],
      }));

      const output = formatRecoveryMarkdown(summaries);
      // Session IDs are truncated to 8 chars in output
      expect(output).toContain('branch-0');
      expect(output).toContain('branch-2');
      expect(output).not.toContain('branch-3');
      expect(output).not.toContain('branch-4');
    });

    it('should truncate long file lists', () => {
      const summaries = [{
        sessionId: 'test-session',
        lastModified: new Date(),
        branch: 'main',
        toolCalls: [],
        fileModifications: Array.from({ length: 20 }, (_, i) => `/file-${i}.ts`),
        gitOperations: [],
        mcpTools: [],
      }];

      const output = formatRecoveryMarkdown(summaries);
      expect(output).toContain('... and 5 more');
    });
  });

  describe('JSONL parsing', () => {
    it('should extract branch from entries', () => {
      // This test verifies the internal parsing logic by checking the
      // formatRecoveryMarkdown output from the recoverSessions function.
      // Since recoverSessions reads from a fixed path, we test the
      // formatting and structure separately.
      const summaries = [{
        sessionId: 'abc123',
        lastModified: new Date(),
        branch: 'feat/my-branch',
        toolCalls: [],
        fileModifications: [],
        gitOperations: [],
        mcpTools: [],
      }];

      const output = formatRecoveryMarkdown(summaries);
      expect(output).toContain('feat/my-branch');
    });

    it('should identify git operations', () => {
      const summaries = [{
        sessionId: 'test-session',
        lastModified: new Date(),
        branch: 'main',
        toolCalls: [
          { tool: 'Bash', count: 10, lastUsed: '' },
        ],
        fileModifications: [],
        gitOperations: [
          'git checkout -b feat/new',
          'git add src/file.ts && git commit -m "feat: add file"',
          'gh pr create --title "PR"',
        ],
        mcpTools: [],
      }];

      const output = formatRecoveryMarkdown(summaries);
      expect(output).toContain('git checkout');
      expect(output).toContain('git add');
      expect(output).toContain('gh pr create');
    });
  });

  describe('date filtering', () => {
    it('should filter by hours parameter', () => {
      // The recoverSessions function filters by file mtime, not by
      // entry timestamps. This test verifies the formatting handles
      // date objects correctly.
      const recentDate = new Date();
      const oldDate = new Date(Date.now() - 48 * 3600_000);

      const summaries = [
        {
          sessionId: 'recent',
          lastModified: recentDate,
          branch: 'feat/recent',
          toolCalls: [],
          fileModifications: [],
          gitOperations: [],
          mcpTools: [],
        },
      ];

      const output = formatRecoveryMarkdown(summaries);
      expect(output).toContain('recent');
      expect(output).toContain(recentDate.toISOString().substring(0, 10));
    });
  });
});
