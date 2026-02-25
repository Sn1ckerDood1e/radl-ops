/**
 * DataFetcher Pattern Tests
 *
 * Tests the executeFetcher utility and each concrete fetcher's
 * transform/extract/result logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { executeFetcher, type DataFetcher, type FetcherResult } from './data-fetcher.js';
import { vercelFetcher } from './vercel-fetcher.js';
import { supabaseFetcher } from './supabase-fetcher.js';
import { sentryFetcher } from './sentry-fetcher.js';
import { githubFetcher } from './github-fetcher.js';

// Mock global fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── executeFetcher core ──────────────────────────────────

describe('executeFetcher', () => {
  const testFetcher: DataFetcher<{ token: string }, { value: number }> = {
    name: 'test',
    transformQuery({ token }) {
      if (!token) return null;
      return { url: 'https://api.test.com/data', headers: { Auth: token } };
    },
    extractData(raw) {
      return { value: (raw as { val: number }).val };
    },
    transformResult(data, error) {
      if (error === 'not_configured') {
        return { status: 'unavailable', summary: 'Not configured', data: null };
      }
      if (!data) {
        return { status: 'error', summary: `Failed: ${error}`, data: null };
      }
      return { status: 'ok', summary: `Value: ${data.value}`, data };
    },
  };

  it('returns unavailable when transformQuery returns null', async () => {
    const result = await executeFetcher(testFetcher, { token: '' });
    expect(result.status).toBe('unavailable');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches and returns transformed data on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ val: 42 }),
    });

    const result = await executeFetcher(testFetcher, { token: 'abc' });
    expect(result.status).toBe('ok');
    expect(result.data).toEqual({ value: 42 });
    expect(result.summary).toBe('Value: 42');
  });

  it('returns error on non-OK response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });

    const result = await executeFetcher(testFetcher, { token: 'abc' });
    expect(result.status).toBe('error');
    expect(result.data).toBeNull();
  });

  it('returns error on fetch exception', async () => {
    mockFetch.mockRejectedValue(new Error('network timeout'));

    const result = await executeFetcher(testFetcher, { token: 'abc' });
    expect(result.status).toBe('error');
    expect(result.summary).toContain('network timeout');
  });
});

// ─── Vercel Fetcher ──────────────────────────────────

describe('vercelFetcher', () => {
  it('returns null query when credentials missing', () => {
    expect(vercelFetcher.transformQuery({ token: '', projectId: '' })).toBeNull();
  });

  it('builds correct URL', () => {
    const req = vercelFetcher.transformQuery({ token: 'tk', projectId: 'proj' });
    expect(req!.url).toContain('projectId=proj');
    expect(req!.headers.Authorization).toBe('Bearer tk');
  });

  it('extracts deployment data', () => {
    const data = vercelFetcher.extractData({
      deployments: [
        { uid: '1', readyState: 'READY', createdAt: Date.now() - 3600000 },
        { uid: '2', readyState: 'ERROR', createdAt: Date.now() - 7200000 },
      ],
    });
    expect(data.latest).not.toBeNull();
    expect(data.failedCount).toBe(1);
    expect(data.hoursAgo).toBeGreaterThanOrEqual(0);
  });

  it('returns ok for healthy latest deployment', () => {
    const result = vercelFetcher.transformResult({
      deployments: [{ uid: '1', readyState: 'READY', createdAt: Date.now() }],
      latest: { uid: '1', readyState: 'READY', createdAt: Date.now() },
      failedCount: 0,
      hoursAgo: 0,
    });
    expect(result.status).toBe('ok');
  });

  it('returns warning when recent failures exist', () => {
    const result = vercelFetcher.transformResult({
      deployments: [{ uid: '1', readyState: 'READY', createdAt: Date.now() }],
      latest: { uid: '1', readyState: 'READY', createdAt: Date.now() },
      failedCount: 2,
      hoursAgo: 1,
    });
    expect(result.status).toBe('warning');
  });
});

// ─── Supabase Fetcher ──────────────────────────────────

describe('supabaseFetcher', () => {
  it('returns null query when credentials missing', () => {
    expect(supabaseFetcher.transformQuery({ projectId: '', accessToken: '' })).toBeNull();
  });

  it('returns ok for ACTIVE_HEALTHY status', () => {
    const result = supabaseFetcher.transformResult({
      name: 'Radl', status: 'ACTIVE_HEALTHY', region: 'us-east-1',
    });
    expect(result.status).toBe('ok');
  });

  it('returns warning for non-healthy status', () => {
    const result = supabaseFetcher.transformResult({
      name: 'Radl', status: 'PAUSED', region: 'us-east-1',
    });
    expect(result.status).toBe('warning');
  });
});

// ─── Sentry Fetcher ──────────────────────────────────

describe('sentryFetcher', () => {
  it('returns null query when credentials missing', () => {
    expect(sentryFetcher.transformQuery({ authToken: '', org: '', project: '' })).toBeNull();
  });

  it('extracts error/warning counts', () => {
    const data = sentryFetcher.extractData([
      { id: '1', title: 'Error 1', level: 'error', count: '5' },
      { id: '2', title: 'Warn 1', level: 'warning', count: '2' },
      { id: '3', title: 'Error 2', level: 'error', count: '3' },
    ]);
    expect(data.errorCount).toBe(2);
    expect(data.warningCount).toBe(1);
    expect(data.issues).toHaveLength(3);
  });

  it('returns ok when no issues', () => {
    const result = sentryFetcher.transformResult({ issues: [], errorCount: 0, warningCount: 0 });
    expect(result.status).toBe('ok');
  });

  it('returns error when many errors', () => {
    const issues = Array.from({ length: 10 }, (_, i) => ({
      id: String(i), title: `Error ${i}`, level: 'error', count: '1',
    }));
    const result = sentryFetcher.transformResult({ issues, errorCount: 8, warningCount: 2 });
    expect(result.status).toBe('error');
  });
});

// ─── GitHub Fetcher ──────────────────────────────────

describe('githubFetcher', () => {
  it('returns null query when token missing', () => {
    expect(githubFetcher.transformQuery({ token: '', owner: 'o', repo: 'r' })).toBeNull();
  });

  it('filters out PRs from issues', () => {
    const data = githubFetcher.extractData([
      { number: 1, title: 'Issue', labels: [], created_at: '' },
      { number: 2, title: 'PR', labels: [], created_at: '', pull_request: {} },
    ]);
    expect(data.issues).toHaveLength(1);
    expect(data.issues[0].number).toBe(1);
  });

  it('counts bugs from labels', () => {
    const data = githubFetcher.extractData([
      { number: 1, title: 'Bug fix', labels: [{ name: 'bug' }] },
      { number: 2, title: 'Feature', labels: [{ name: 'enhancement' }] },
    ]);
    expect(data.bugCount).toBe(1);
  });

  it('returns warning when many bugs', () => {
    const issues = Array.from({ length: 5 }, (_, i) => ({
      number: i, title: `Bug ${i}`, labels: [{ name: 'bug' }],
    }));
    const result = githubFetcher.transformResult({ issues, bugCount: 5 });
    expect(result.status).toBe('warning');
  });
});
