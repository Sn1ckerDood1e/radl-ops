import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withRetry, isRetryableError } from './retry.js';

const mockSleep = vi.fn().mockResolvedValue(undefined);

describe('isRetryableError', () => {
  it('returns true for 429 rate limit', () => {
    const error = Object.assign(new Error('Rate limited'), { status: 429 });
    expect(isRetryableError(error)).toBe(true);
  });

  it('returns true for 500 server error', () => {
    const error = Object.assign(new Error('Server error'), { status: 500 });
    expect(isRetryableError(error)).toBe(true);
  });

  it('returns true for 503 service unavailable', () => {
    const error = Object.assign(new Error('Unavailable'), { status: 503 });
    expect(isRetryableError(error)).toBe(true);
  });

  it('returns false for 400 bad request', () => {
    const error = Object.assign(new Error('Bad request'), { status: 400 });
    expect(isRetryableError(error)).toBe(false);
  });

  it('returns false for 401 unauthorized', () => {
    const error = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(isRetryableError(error)).toBe(false);
  });

  it('returns false for 403 forbidden', () => {
    const error = Object.assign(new Error('Forbidden'), { status: 403 });
    expect(isRetryableError(error)).toBe(false);
  });

  it('returns true for errors without status (unknown)', () => {
    expect(isRetryableError(new Error('Network error'))).toBe(true);
  });

  it('returns true for non-Error objects', () => {
    expect(isRetryableError('string error')).toBe(true);
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn, { _sleep: mockSleep });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it('retries on transient error and succeeds', async () => {
    const error = Object.assign(new Error('Rate limited'), { status: 429 });
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('recovered');

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 100, _sleep: mockSleep });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledWith(100); // baseDelay * 2^0
  });

  it('does not retry on permanent error (400)', async () => {
    const error = Object.assign(new Error('Bad request'), { status: 400 });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { maxRetries: 3, _sleep: mockSleep })).rejects.toThrow('Bad request');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it('does not retry on permanent error (401)', async () => {
    const error = Object.assign(new Error('Unauthorized'), { status: 401 });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { maxRetries: 3, _sleep: mockSleep })).rejects.toThrow('Unauthorized');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting retries', async () => {
    const error = Object.assign(new Error('Server error'), { status: 500 });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 100, _sleep: mockSleep })).rejects.toThrow('Server error');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(mockSleep).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledWith(100);  // 100 * 2^0
    expect(mockSleep).toHaveBeenCalledWith(200);  // 100 * 2^1
  });

  it('uses exponential backoff delays', async () => {
    const error = Object.assign(new Error('Unavailable'), { status: 503 });
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('ok');

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1000, _sleep: mockSleep });
    expect(result).toBe('ok');
    expect(mockSleep).toHaveBeenCalledWith(1000);  // 1000 * 2^0
    expect(mockSleep).toHaveBeenCalledWith(2000);  // 1000 * 2^1
    expect(mockSleep).toHaveBeenCalledWith(4000);  // 1000 * 2^2
  });

  it('uses default options when none provided', async () => {
    const error = Object.assign(new Error('Fail'), { status: 500 });
    const fn = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('ok');

    // Use _sleep to avoid real delays, but verify defaults for maxRetries
    const result = await withRetry(fn, { _sleep: mockSleep });
    expect(result).toBe('ok');
    expect(mockSleep).toHaveBeenCalledWith(1000); // default baseDelayMs * 2^0
  });
});
