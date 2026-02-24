/**
 * Anthropic Batch API Utility
 *
 * Wraps the Anthropic Message Batches API for async, non-time-sensitive
 * processing at 50% cost discount. Suitable for:
 * - Nightly compound learning extraction
 * - Bulk knowledge re-indexing
 * - Trust report generation
 *
 * The Batch API processes requests asynchronously (up to 24h SLA).
 * Use for operations where latency doesn't matter.
 */

import { getAnthropicClient } from '../config/anthropic.js';
import { logger } from '../config/logger.js';

export interface BatchRequest {
  custom_id: string;
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  system?: string;
}

export interface BatchResult {
  custom_id: string;
  success: boolean;
  content?: string;
  error?: string;
}

export interface BatchOptions {
  /** Polling interval in ms (default 10000) */
  pollIntervalMs?: number;
  /** Max time to wait for batch completion in ms (default 300000 = 5 min) */
  timeoutMs?: number;
  /** Injectable sleep function for testing */
  _sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_OPTIONS: Required<BatchOptions> = {
  pollIntervalMs: 10_000,
  timeoutMs: 300_000,
  _sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
};

/**
 * Submit a batch of message requests to the Anthropic Batch API.
 *
 * Returns the batch ID for later retrieval. Does NOT wait for completion.
 * Use `awaitBatch` to poll for results.
 */
export async function submitBatch(requests: BatchRequest[]): Promise<string> {
  if (requests.length === 0) {
    throw new Error('Cannot submit empty batch');
  }

  const client = getAnthropicClient();

  const batchRequests = requests.map(req => ({
    custom_id: req.custom_id,
    params: {
      model: req.model,
      max_tokens: req.max_tokens,
      messages: req.messages,
      ...(req.system ? { system: req.system } : {}),
    },
  }));

  const batch = await client.beta.messages.batches.create({
    requests: batchRequests,
  });

  logger.info('Batch submitted', {
    batchId: batch.id,
    requestCount: requests.length,
  });

  return batch.id;
}

/**
 * Poll for batch completion and return results.
 *
 * Polls at configurable intervals until the batch reaches a terminal
 * state (ended) or timeout is exceeded.
 */
export async function awaitBatch(
  batchId: string,
  options: BatchOptions = {},
): Promise<BatchResult[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { pollIntervalMs, timeoutMs, _sleep } = opts;
  const client = getAnthropicClient();
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const batch = await client.beta.messages.batches.retrieve(batchId);

    if (batch.processing_status === 'ended') {
      return await collectResults(batchId);
    }

    logger.info('Batch still processing', {
      batchId,
      status: batch.processing_status,
      elapsed: `${Math.round((Date.now() - startTime) / 1000)}s`,
    });

    await _sleep(pollIntervalMs);
  }

  logger.warn('Batch timed out', { batchId, timeoutMs });
  throw new Error(`Batch ${batchId} did not complete within ${timeoutMs}ms`);
}

/**
 * Submit a batch and wait for results in one call.
 *
 * Convenience wrapper combining submitBatch + awaitBatch.
 */
export async function runBatch(
  requests: BatchRequest[],
  options: BatchOptions = {},
): Promise<BatchResult[]> {
  const batchId = await submitBatch(requests);
  return await awaitBatch(batchId, options);
}

/**
 * Collect results from a completed batch.
 */
async function collectResults(batchId: string): Promise<BatchResult[]> {
  const client = getAnthropicClient();
  const results: BatchResult[] = [];

  const resultsStream = await client.beta.messages.batches.results(batchId);
  for await (const result of resultsStream) {
    if (result.result.type === 'succeeded') {
      const message = result.result.message;
      const textBlock = message.content.find(
        (block: { type: string }) => block.type === 'text',
      );
      results.push({
        custom_id: result.custom_id,
        success: true,
        content: textBlock && 'text' in textBlock ? textBlock.text : '',
      });
    } else {
      results.push({
        custom_id: result.custom_id,
        success: false,
        error: result.result.type === 'errored'
          ? JSON.stringify(result.result.error)
          : `Batch item ${result.result.type}`,
      });
    }
  }

  logger.info('Batch results collected', {
    batchId,
    total: results.length,
    succeeded: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
  });

  return results;
}
