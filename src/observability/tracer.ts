/**
 * Lightweight span-level tracing for MCP tool calls and AI operations.
 *
 * No external dependencies. Writes traces to knowledge/traces/ as JSONL.
 * Provides in-memory query for the current session and disk query for history.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../config/paths.js';
import { logger } from '../config/logger.js';

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheHit?: boolean;
  durationMs: number;
  startedAt: string;
  status: 'ok' | 'error';
  error?: string;
  tags?: Record<string, string>;
}

interface ActiveSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  tags?: Record<string, string>;
}

// In-memory storage for current session
const sessionSpans: Span[] = [];
const activeSpans = new Map<string, ActiveSpan>();
let spanCounter = 0;

function generateId(): string {
  spanCounter++;
  return `${Date.now().toString(36)}-${spanCounter.toString(36)}`;
}

function getTracesDir(): string {
  const dir = join(getConfig().knowledgeDir, 'traces');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getTraceFile(): string {
  const date = new Date().toISOString().split('T')[0];
  return join(getTracesDir(), `trace-${date}.jsonl`);
}

/**
 * Start a new span. Returns a spanId to pass to endSpan().
 */
export function startSpan(
  name: string,
  opts?: { traceId?: string; parentSpanId?: string; tags?: Record<string, string> }
): string {
  const spanId = generateId();
  const traceId = opts?.traceId ?? generateId();

  activeSpans.set(spanId, {
    traceId,
    spanId,
    parentSpanId: opts?.parentSpanId,
    name,
    startTime: Date.now(),
    tags: opts?.tags,
  });

  return spanId;
}

/**
 * End a span and record its metrics.
 */
export function endSpan(
  spanId: string,
  result: {
    status?: 'ok' | 'error';
    error?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } = {}
): Span | null {
  const active = activeSpans.get(spanId);
  if (!active) {
    logger.warn('Attempted to end unknown span', { spanId });
    return null;
  }

  activeSpans.delete(spanId);

  const durationMs = Date.now() - active.startTime;
  const cacheHit = (result.cacheReadTokens ?? 0) > 0;

  const span: Span = {
    traceId: active.traceId,
    spanId: active.spanId,
    parentSpanId: active.parentSpanId,
    name: active.name,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheWriteTokens: result.cacheWriteTokens,
    cacheHit,
    durationMs,
    startedAt: new Date(active.startTime).toISOString(),
    status: result.status ?? 'ok',
    error: result.error,
    tags: active.tags,
  };

  sessionSpans.push(span);

  // Persist to disk
  try {
    appendFileSync(getTraceFile(), JSON.stringify(span) + '\n');
  } catch (err) {
    logger.warn('Failed to persist trace span', { spanId, error: String(err) });
  }

  return span;
}

/**
 * Get all spans from the current session.
 */
export function getSessionSpans(): readonly Span[] {
  return sessionSpans;
}

/**
 * Get spans from a specific date (from disk).
 */
export function getSpansForDate(date: string): Span[] {
  // Defense in depth: validate date format to prevent path traversal
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    logger.warn('getSpansForDate: invalid date format rejected', { date: date.substring(0, 20) });
    return [];
  }
  const file = join(getTracesDir(), `trace-${date}.jsonl`);
  if (!existsSync(file)) return [];

  try {
    const lines = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.map(line => JSON.parse(line) as Span);
  } catch (err) {
    logger.warn('Failed to read trace file', { date, error: String(err) });
    return [];
  }
}

/**
 * Aggregate trace statistics for a date range.
 */
export function aggregateTraces(spans: readonly Span[]): TraceReport {
  const totalDuration = spans.reduce((sum, s) => sum + s.durationMs, 0);
  const totalInput = spans.reduce((sum, s) => sum + (s.inputTokens ?? 0), 0);
  const totalOutput = spans.reduce((sum, s) => sum + (s.outputTokens ?? 0), 0);
  const totalCacheRead = spans.reduce((sum, s) => sum + (s.cacheReadTokens ?? 0), 0);
  const errorCount = spans.filter(s => s.status === 'error').length;

  // Group by name
  const byName = new Map<string, { count: number; totalMs: number; errors: number }>();
  for (const span of spans) {
    const existing = byName.get(span.name) ?? { count: 0, totalMs: 0, errors: 0 };
    byName.set(span.name, {
      count: existing.count + 1,
      totalMs: existing.totalMs + span.durationMs,
      errors: existing.errors + (span.status === 'error' ? 1 : 0),
    });
  }

  // Group by model
  const byModel = new Map<string, { count: number; inputTokens: number; outputTokens: number }>();
  for (const span of spans) {
    if (!span.model) continue;
    const existing = byModel.get(span.model) ?? { count: 0, inputTokens: 0, outputTokens: 0 };
    byModel.set(span.model, {
      count: existing.count + 1,
      inputTokens: existing.inputTokens + (span.inputTokens ?? 0),
      outputTokens: existing.outputTokens + (span.outputTokens ?? 0),
    });
  }

  return {
    spanCount: spans.length,
    totalDurationMs: totalDuration,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheReadTokens: totalCacheRead,
    cacheHitRate: spans.length > 0
      ? spans.filter(s => s.cacheHit).length / spans.length
      : 0,
    errorRate: spans.length > 0 ? errorCount / spans.length : 0,
    byName: Object.fromEntries(byName),
    byModel: Object.fromEntries(byModel),
  };
}

export interface TraceReport {
  spanCount: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  cacheHitRate: number;
  errorRate: number;
  byName: Record<string, { count: number; totalMs: number; errors: number }>;
  byModel: Record<string, { count: number; inputTokens: number; outputTokens: number }>;
}

/** Reset session spans (for testing). */
export function resetSessionSpans(): void {
  sessionSpans.length = 0;
  activeSpans.clear();
  spanCounter = 0;
}
