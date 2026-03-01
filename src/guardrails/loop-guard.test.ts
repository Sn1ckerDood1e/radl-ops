import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  checkToolCall,
  recordToolResult,
  resetLoopGuard,
  getLoopGuardStats,
} from './loop-guard.js';

describe('loop-guard', () => {
  beforeEach(() => {
    resetLoopGuard();
    vi.clearAllMocks();
  });

  describe('checkToolCall', () => {
    it('allows first call', () => {
      const result = checkToolCall('read_file', { path: '/a.ts' });
      expect(result.action).toBe('allow');
      expect(result.callCount).toBe(1);
    });

    it('allows calls below warn threshold', () => {
      checkToolCall('read_file', { path: '/a.ts' });
      const result = checkToolCall('read_file', { path: '/a.ts' });
      expect(result.action).toBe('allow');
      expect(result.callCount).toBe(2);
    });

    it('warns at threshold 3', () => {
      checkToolCall('edit_file', { path: '/b.ts' });
      checkToolCall('edit_file', { path: '/b.ts' });
      const result = checkToolCall('edit_file', { path: '/b.ts' });
      expect(result.action).toBe('warn');
      expect(result.callCount).toBe(3);
      expect(result.reason).toContain('3 times');
    });

    it('blocks at threshold 5', () => {
      // Interleave unique calls to avoid triggering ping-pong detection
      // while still hitting count threshold for the target tool.
      checkToolCall('bash', { cmd: 'ls' });        // count=1, allow
      checkToolCall('unique1', { id: 1 });
      checkToolCall('bash', { cmd: 'ls' });        // count=2, allow
      checkToolCall('unique2', { id: 2 });
      checkToolCall('bash', { cmd: 'ls' });        // count=3, warn
      checkToolCall('unique3', { id: 3 });
      checkToolCall('bash', { cmd: 'ls' });        // count=4, warn
      checkToolCall('unique4', { id: 4 });

      const result = checkToolCall('bash', { cmd: 'ls' }); // count=5
      expect(result.action).toBe('block');
      expect(result.callCount).toBe(5);
      expect(result.reason).toContain('blocked at 5');
    });

    it('triggers global circuit break at 30 loops', () => {
      // Each tool at threshold 3 counts as 1 loop detection
      for (let i = 0; i < 30; i++) {
        const toolName = `tool_${Math.floor(i / 3)}`;
        checkToolCall(toolName, { id: Math.floor(i / 3) });
        checkToolCall(toolName, { id: Math.floor(i / 3) });
        checkToolCall(toolName, { id: Math.floor(i / 3) }); // warn = +1 loop
      }
      // totalLoopsDetected should now be >= 30
      const result = checkToolCall('new_tool', { x: 1 });
      expect(result.action).toBe('block');
      expect(result.reason).toContain('Global circuit break');
    });

    it('detects A-B-A-B ping-pong pattern (period 2)', () => {
      checkToolCall('toolA', { x: 1 });
      checkToolCall('toolB', { x: 2 });
      checkToolCall('toolA', { x: 1 });
      const result = checkToolCall('toolB', { x: 2 });
      expect(result.action).toBe('warn');
      expect(result.reason).toContain('Ping-pong');
      expect(result.reason).toContain('2-step cycle');
    });

    it('detects A-B-C-A-B-C ping-pong pattern (period 3)', () => {
      checkToolCall('toolA', { x: 1 });
      checkToolCall('toolB', { x: 2 });
      checkToolCall('toolC', { x: 3 });
      checkToolCall('toolA', { x: 1 });
      checkToolCall('toolB', { x: 2 });
      const result = checkToolCall('toolC', { x: 3 });
      expect(result.action).toBe('warn');
      expect(result.reason).toContain('Ping-pong');
      expect(result.reason).toContain('3-step cycle');
    });
  });

  describe('recordToolResult', () => {
    it('tracks outcome-aware escalation', async () => {
      const { logger } = await import('../config/logger.js');

      // Call + record same result twice → WARN_THRESHOLD - 1 = 2
      checkToolCall('read_file', { path: '/c.ts' });
      recordToolResult('read_file', { path: '/c.ts' }, { content: 'same' });

      checkToolCall('read_file', { path: '/c.ts' });
      recordToolResult('read_file', { path: '/c.ts' }, { content: 'same' });

      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Loop guard: outcome-aware escalation',
        expect.objectContaining({ outcomeCount: 2 }),
      );
    });
  });

  describe('resetLoopGuard', () => {
    it('clears all state', () => {
      checkToolCall('tool1', { a: 1 });
      checkToolCall('tool1', { a: 1 });
      checkToolCall('tool1', { a: 1 });

      resetLoopGuard();

      const result = checkToolCall('tool1', { a: 1 });
      expect(result.action).toBe('allow');
      expect(result.callCount).toBe(1);

      const stats = getLoopGuardStats();
      expect(stats.loopsDetected).toBe(0);
    });
  });

  describe('getLoopGuardStats', () => {
    it('returns stats with top repeaters', () => {
      checkToolCall('toolX', { a: 1 });
      checkToolCall('toolX', { a: 1 });
      checkToolCall('toolY', { b: 2 });

      const stats = getLoopGuardStats();
      expect(stats.totalCalls).toBe(3);
      expect(stats.uniqueCalls).toBe(2);
      expect(stats.topRepeaters).toHaveLength(1); // only toolX has count >= 2
      expect(stats.topRepeaters[0].count).toBe(2);
    });
  });

  describe('history window trim', () => {
    it('trims call history when exceeding HISTORY_WINDOW * 2', () => {
      // HISTORY_WINDOW = 30, trims when length > 60, splices to 30
      // Push 61 entries to trigger trim (61 > 60 → splice to 30)
      for (let i = 0; i < 61; i++) {
        checkToolCall(`tool_${i}`, { id: i });
      }

      const stats = getLoopGuardStats();
      // After trim: spliced to 30, then pushed 1 more = 30
      // (splice removes length - HISTORY_WINDOW = 31 entries, leaving 30)
      expect(stats.totalCalls).toBe(30);
    });
  });
});
