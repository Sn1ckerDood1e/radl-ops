/**
 * Tracer Tests — span-level observability
 *
 * Tests for:
 * - startSpan/endSpan lifecycle
 * - Session span collection
 * - Disk persistence (JSONL)
 * - aggregateTraces report generation
 * - Date-based span retrieval
 * - Edge cases (unknown spanId, empty spans)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  appendFileSync: vi.fn(),
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../config/paths.js', () => ({
  getConfig: vi.fn(() => ({
    knowledgeDir: '/tmp/test-knowledge',
  })),
}));

import { appendFileSync, readFileSync, existsSync } from 'fs';
import {
  startSpan,
  endSpan,
  getSessionSpans,
  getSpansForDate,
  aggregateTraces,
  resetSessionSpans,
} from './tracer.js';

describe('Tracer', () => {
  beforeEach(() => {
    resetSessionSpans();
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
  });

  describe('startSpan/endSpan', () => {
    it('creates and completes a span', () => {
      const spanId = startSpan('test-op');
      expect(spanId).toBeTruthy();

      const span = endSpan(spanId, {
        status: 'ok',
        model: 'claude-haiku',
        inputTokens: 100,
        outputTokens: 50,
      });

      expect(span).not.toBeNull();
      expect(span!.name).toBe('test-op');
      expect(span!.model).toBe('claude-haiku');
      expect(span!.inputTokens).toBe(100);
      expect(span!.outputTokens).toBe(50);
      expect(span!.status).toBe('ok');
      expect(span!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('sets cacheHit=true when cacheReadTokens > 0', () => {
      const spanId = startSpan('cached-op');
      const span = endSpan(spanId, {
        status: 'ok',
        cacheReadTokens: 500,
      });

      expect(span!.cacheHit).toBe(true);
      expect(span!.cacheReadTokens).toBe(500);
    });

    it('sets cacheHit=false when no cache tokens', () => {
      const spanId = startSpan('uncached-op');
      const span = endSpan(spanId, { status: 'ok' });

      expect(span!.cacheHit).toBe(false);
    });

    it('preserves tags and parentSpanId', () => {
      const parentSpanId = startSpan('parent');
      const childSpanId = startSpan('child', {
        traceId: 'trace-1',
        parentSpanId,
        tags: { step: 'decompose' },
      });

      const child = endSpan(childSpanId, { status: 'ok' });
      endSpan(parentSpanId, { status: 'ok' });

      expect(child!.parentSpanId).toBe(parentSpanId);
      expect(child!.tags).toEqual({ step: 'decompose' });
      expect(child!.traceId).toBe('trace-1');
    });

    it('returns null for unknown spanId', () => {
      const result = endSpan('nonexistent');
      expect(result).toBeNull();
    });

    it('defaults status to ok', () => {
      const spanId = startSpan('default-status');
      const span = endSpan(spanId);

      expect(span!.status).toBe('ok');
    });

    it('records error status and message', () => {
      const spanId = startSpan('failing-op');
      const span = endSpan(spanId, {
        status: 'error',
        error: 'API timeout',
      });

      expect(span!.status).toBe('error');
      expect(span!.error).toBe('API timeout');
    });
  });

  describe('getSessionSpans', () => {
    it('returns all completed spans for the session', () => {
      const id1 = startSpan('op1');
      const id2 = startSpan('op2');
      endSpan(id1, { status: 'ok' });
      endSpan(id2, { status: 'ok' });

      const spans = getSessionSpans();
      expect(spans).toHaveLength(2);
      expect(spans[0].name).toBe('op1');
      expect(spans[1].name).toBe('op2');
    });

    it('returns empty array after reset', () => {
      const id = startSpan('temp');
      endSpan(id, { status: 'ok' });
      expect(getSessionSpans()).toHaveLength(1);

      resetSessionSpans();
      expect(getSessionSpans()).toHaveLength(0);
    });
  });

  describe('disk persistence', () => {
    it('writes span to JSONL file on endSpan', () => {
      const spanId = startSpan('persisted-op');
      endSpan(spanId, { status: 'ok', model: 'haiku' });

      expect(appendFileSync).toHaveBeenCalledTimes(1);
      const [filePath, content] = vi.mocked(appendFileSync).mock.calls[0];
      expect(String(filePath)).toMatch(/trace-\d{4}-\d{2}-\d{2}\.jsonl$/);
      const parsed = JSON.parse(String(content).trim());
      expect(parsed.name).toBe('persisted-op');
      expect(parsed.model).toBe('haiku');
    });

    it('handles write failure gracefully', () => {
      vi.mocked(appendFileSync).mockImplementation(() => {
        throw new Error('disk full');
      });

      const spanId = startSpan('will-fail-write');
      // Should not throw — writes fail silently
      const span = endSpan(spanId, { status: 'ok' });
      expect(span).not.toBeNull();
    });
  });

  describe('getSpansForDate', () => {
    it('reads and parses JSONL from disk', () => {
      const mockSpan = JSON.stringify({
        traceId: 't1',
        spanId: 's1',
        name: 'historical',
        durationMs: 100,
        startedAt: '2026-02-24T08:00:00.000Z',
        status: 'ok',
      });

      vi.mocked(readFileSync).mockReturnValue(mockSpan + '\n');

      const spans = getSpansForDate('2026-02-24');
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe('historical');
    });

    it('returns empty array when file does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const spans = getSpansForDate('2099-01-01');
      expect(spans).toHaveLength(0);
    });

    it('returns empty array on read error', () => {
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('read error');
      });

      const spans = getSpansForDate('2026-02-24');
      expect(spans).toHaveLength(0);
    });
  });

  describe('aggregateTraces', () => {
    it('aggregates empty spans correctly', () => {
      const report = aggregateTraces([]);

      expect(report.spanCount).toBe(0);
      expect(report.totalDurationMs).toBe(0);
      expect(report.totalInputTokens).toBe(0);
      expect(report.totalOutputTokens).toBe(0);
      expect(report.cacheHitRate).toBe(0);
      expect(report.errorRate).toBe(0);
    });

    it('computes correct totals', () => {
      const id1 = startSpan('op1');
      const id2 = startSpan('op2');
      endSpan(id1, { status: 'ok', inputTokens: 100, outputTokens: 50, cacheReadTokens: 80 });
      endSpan(id2, { status: 'error', inputTokens: 200, outputTokens: 100 });

      const report = aggregateTraces(getSessionSpans());

      expect(report.spanCount).toBe(2);
      expect(report.totalInputTokens).toBe(300);
      expect(report.totalOutputTokens).toBe(150);
      expect(report.totalCacheReadTokens).toBe(80);
      expect(report.errorRate).toBe(0.5);
      expect(report.cacheHitRate).toBe(0.5); // 1 of 2 had cacheHit
    });

    it('groups by operation name', () => {
      const id1 = startSpan('decompose');
      const id2 = startSpan('decompose');
      const id3 = startSpan('generate');
      endSpan(id1, { status: 'ok' });
      endSpan(id2, { status: 'error' });
      endSpan(id3, { status: 'ok' });

      const report = aggregateTraces(getSessionSpans());

      expect(report.byName['decompose']).toEqual({
        count: 2,
        totalMs: expect.any(Number),
        errors: 1,
      });
      expect(report.byName['generate']).toEqual({
        count: 1,
        totalMs: expect.any(Number),
        errors: 0,
      });
    });

    it('groups by model', () => {
      const id1 = startSpan('op1');
      const id2 = startSpan('op2');
      endSpan(id1, { status: 'ok', model: 'haiku', inputTokens: 100, outputTokens: 50 });
      endSpan(id2, { status: 'ok', model: 'sonnet', inputTokens: 200, outputTokens: 100 });

      const report = aggregateTraces(getSessionSpans());

      expect(report.byModel['haiku']).toEqual({
        count: 1,
        inputTokens: 100,
        outputTokens: 50,
      });
      expect(report.byModel['sonnet']).toEqual({
        count: 1,
        inputTokens: 200,
        outputTokens: 100,
      });
    });

    it('excludes spans without model from byModel', () => {
      const id1 = startSpan('no-model');
      endSpan(id1, { status: 'ok' });

      const report = aggregateTraces(getSessionSpans());

      expect(Object.keys(report.byModel)).toHaveLength(0);
    });
  });
});
