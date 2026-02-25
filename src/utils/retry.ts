/**
 * Retry with Exponential Backoff
 *
 * Retries on transient errors (429/500/503) with exponential backoff.
 * Does NOT retry on permanent errors (400/401/403).
 */

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  /** Injectable sleep function for testing */
  _sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  _sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
};

/** HTTP status codes that should trigger a retry */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 503]);

/** HTTP status code indicating rate limiting — candidate for model fallback */
const RATE_LIMIT_STATUS = 429;

/** HTTP status codes that indicate permanent failure — never retry */
const PERMANENT_STATUS_CODES = new Set([400, 401, 403]);

/**
 * Check if an error is a rate limit (429) — signals model fallback candidate.
 */
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    const status = (error as unknown as Record<string, unknown>).status;
    return typeof status === 'number' && status === RATE_LIMIT_STATUS;
  }
  return false;
}

/**
 * Check if an error is retryable based on its status code.
 * Returns true for 429/500/503, false for 400/401/403.
 * Unknown errors (no status) are retried as a safety net.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    // Anthropic SDK errors have a `status` property
    const status = (error as unknown as Record<string, unknown>).status;
    if (typeof status === 'number') {
      if (PERMANENT_STATUS_CODES.has(status)) return false;
      if (RETRYABLE_STATUS_CODES.has(status)) return true;
    }
  }
  // Unknown errors — retry as safety net
  return true;
}

/**
 * Execute a function with retry logic and exponential backoff.
 *
 * @param fn - Async function to execute
 * @param options - Retry configuration
 * @returns The result of fn
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { maxRetries, baseDelayMs, _sleep } = opts;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRetryableError(error)) {
        throw error;
      }

      if (attempt === maxRetries) {
        break;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt);
      await _sleep(delayMs);
    }
  }

  throw lastError;
}
