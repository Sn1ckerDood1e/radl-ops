/**
 * Tests for session-health MCP tool
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recordToolCall, recordCommit } from './shared/session-state.js';

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../guardrails/iron-laws.js', () => ({
  recordError: vi.fn(() => 1),
  clearError: vi.fn(),
}));

describe('session-health', () => {
  it('should export recordToolCall function', () => {
    expect(recordToolCall).toBeDefined();
    expect(typeof recordToolCall).toBe('function');
  });

  it('should export recordCommit function', () => {
    expect(recordCommit).toBeDefined();
    expect(typeof recordCommit).toBe('function');
  });

  it('should record tool calls without throwing', () => {
    expect(() => recordToolCall('test_tool', true)).not.toThrow();
    expect(() => recordToolCall('test_tool', false)).not.toThrow();
  });

  it('should record commits without throwing', () => {
    expect(() => recordCommit()).not.toThrow();
  });

  it('should register session health tool', async () => {
    const { registerSessionHealthTools } = await import('./session-health.js');
    expect(registerSessionHealthTools).toBeDefined();
  });
});
