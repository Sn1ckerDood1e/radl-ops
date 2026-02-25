/**
 * DataFetcher Pattern — standardized external service data retrieval.
 *
 * Transform-Extract-Transform: query params → API call → normalized result.
 * Used by production_status, health_check, and future monitoring tools.
 */

import { logger } from '../config/logger.js';

export interface FetcherResult<R> {
  status: 'ok' | 'warning' | 'error' | 'unavailable';
  summary: string;
  data: R | null;
  details?: string[];
}

export interface DataFetcher<Q, R> {
  name: string;
  transformQuery(params: Q): { url: string; headers: Record<string, string> } | null;
  extractData(raw: unknown): R;
  transformResult(data: R | null, error?: string): FetcherResult<R>;
}

/**
 * Execute a DataFetcher: build request → fetch → extract → transform result.
 */
export async function executeFetcher<Q, R>(
  fetcher: DataFetcher<Q, R>,
  params: Q,
  timeoutMs = 10_000,
): Promise<FetcherResult<R>> {
  const request = fetcher.transformQuery(params);
  if (!request) {
    return fetcher.transformResult(null, 'not_configured');
  }

  try {
    const response = await fetch(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      logger.debug(`${fetcher.name} non-OK response`, { status: response.status });
      return fetcher.transformResult(null, `HTTP ${response.status}`);
    }

    const raw = await response.json();
    const data = fetcher.extractData(raw);
    return fetcher.transformResult(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    logger.debug(`${fetcher.name} fetch failed`, { error: msg });
    return fetcher.transformResult(null, msg);
  }
}
