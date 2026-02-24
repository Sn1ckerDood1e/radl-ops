import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/anthropic.js', () => ({
  getAnthropicClient: vi.fn(),
}));

vi.mock('../config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { submitBatch, awaitBatch, runBatch } from './batch.js';
import { getAnthropicClient } from '../config/anthropic.js';
import type { BatchRequest } from './batch.js';

const mockSleep = vi.fn().mockResolvedValue(undefined);

function makeBatchRequests(count: number): BatchRequest[] {
  return Array.from({ length: count }, (_, i) => ({
    custom_id: `req-${i}`,
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user' as const, content: `Task ${i}` }],
  }));
}

describe('Batch API Utility', () => {
  let mockBatchesCreate: ReturnType<typeof vi.fn>;
  let mockBatchesRetrieve: ReturnType<typeof vi.fn>;
  let mockBatchesResults: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBatchesCreate = vi.fn();
    mockBatchesRetrieve = vi.fn();
    mockBatchesResults = vi.fn();

    vi.mocked(getAnthropicClient).mockReturnValue({
      beta: {
        messages: {
          batches: {
            create: mockBatchesCreate,
            retrieve: mockBatchesRetrieve,
            results: mockBatchesResults,
          },
        },
      },
    } as unknown as ReturnType<typeof getAnthropicClient>);
  });

  describe('submitBatch', () => {
    it('submits requests and returns batch ID', async () => {
      mockBatchesCreate.mockResolvedValue({ id: 'batch_abc123' });

      const batchId = await submitBatch(makeBatchRequests(2));

      expect(batchId).toBe('batch_abc123');
      expect(mockBatchesCreate).toHaveBeenCalledOnce();
      const callArgs = mockBatchesCreate.mock.calls[0][0];
      expect(callArgs.requests).toHaveLength(2);
      expect(callArgs.requests[0].custom_id).toBe('req-0');
      expect(callArgs.requests[0].params.model).toBe('claude-haiku-4-5-20251001');
    });

    it('throws on empty request array', async () => {
      await expect(submitBatch([])).rejects.toThrow('Cannot submit empty batch');
      expect(mockBatchesCreate).not.toHaveBeenCalled();
    });

    it('passes system prompt when provided', async () => {
      mockBatchesCreate.mockResolvedValue({ id: 'batch_sys' });

      await submitBatch([{
        custom_id: 'req-sys',
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: 'Hello' }],
        system: 'You are a helpful assistant',
      }]);

      const callArgs = mockBatchesCreate.mock.calls[0][0];
      expect(callArgs.requests[0].params.system).toBe('You are a helpful assistant');
    });

    it('omits system when not provided', async () => {
      mockBatchesCreate.mockResolvedValue({ id: 'batch_nosys' });

      await submitBatch(makeBatchRequests(1));

      const callArgs = mockBatchesCreate.mock.calls[0][0];
      expect(callArgs.requests[0].params.system).toBeUndefined();
    });

    it('rejects disallowed models', async () => {
      await expect(submitBatch([{
        custom_id: 'req-opus',
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      }])).rejects.toThrow('not permitted for batch API');
      expect(mockBatchesCreate).not.toHaveBeenCalled();
    });

    it('rejects excessive max_tokens', async () => {
      await expect(submitBatch([{
        custom_id: 'req-big',
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 32000,
        messages: [{ role: 'user', content: 'Hi' }],
      }])).rejects.toThrow('exceeds batch limit');
      expect(mockBatchesCreate).not.toHaveBeenCalled();
    });

    it('rejects batch exceeding max request count', async () => {
      await expect(submitBatch(makeBatchRequests(101))).rejects.toThrow('exceeds maximum of 100');
      expect(mockBatchesCreate).not.toHaveBeenCalled();
    });
  });

  describe('awaitBatch', () => {
    it('returns results immediately when batch is already ended', async () => {
      mockBatchesRetrieve.mockResolvedValue({ processing_status: 'ended' });
      mockBatchesResults.mockResolvedValue(makeAsyncIterable([
        {
          custom_id: 'req-0',
          result: {
            type: 'succeeded',
            message: { content: [{ type: 'text', text: 'Result 0' }] },
          },
        },
      ]));

      const results = await awaitBatch('batch_done', { _sleep: mockSleep });

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].content).toBe('Result 0');
      expect(mockSleep).not.toHaveBeenCalled();
    });

    it('polls until batch completes', async () => {
      mockBatchesRetrieve
        .mockResolvedValueOnce({ processing_status: 'in_progress' })
        .mockResolvedValueOnce({ processing_status: 'in_progress' })
        .mockResolvedValueOnce({ processing_status: 'ended' });
      mockBatchesResults.mockResolvedValue(makeAsyncIterable([
        {
          custom_id: 'req-0',
          result: {
            type: 'succeeded',
            message: { content: [{ type: 'text', text: 'Done' }] },
          },
        },
      ]));

      const results = await awaitBatch('batch_poll', {
        pollIntervalMs: 100,
        timeoutMs: 60_000,
        _sleep: mockSleep,
      });

      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('Done');
      expect(mockSleep).toHaveBeenCalledTimes(2);
      expect(mockSleep).toHaveBeenCalledWith(100);
    });

    it('throws on timeout', async () => {
      // Always returns in_progress
      mockBatchesRetrieve.mockResolvedValue({ processing_status: 'in_progress' });

      // Use a very short timeout with a sleep that advances time
      let elapsed = 0;
      const fastSleep = vi.fn().mockImplementation(async (ms: number) => {
        elapsed += ms;
      });

      // Override Date.now to simulate time passing
      const originalNow = Date.now;
      let timeOffset = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => originalNow() + timeOffset);

      // Make sleep advance the mock clock
      const advancingSleep = vi.fn().mockImplementation(async () => {
        timeOffset += 200;
      });

      await expect(
        awaitBatch('batch_timeout', {
          pollIntervalMs: 100,
          timeoutMs: 500,
          _sleep: advancingSleep,
        }),
      ).rejects.toThrow('did not complete within 500ms');

      vi.spyOn(Date, 'now').mockRestore();
    });

    it('handles errored batch items', async () => {
      mockBatchesRetrieve.mockResolvedValue({ processing_status: 'ended' });
      mockBatchesResults.mockResolvedValue(makeAsyncIterable([
        {
          custom_id: 'req-ok',
          result: {
            type: 'succeeded',
            message: { content: [{ type: 'text', text: 'OK' }] },
          },
        },
        {
          custom_id: 'req-fail',
          result: {
            type: 'errored',
            error: { type: 'server_error', message: 'Internal error' },
          },
        },
      ]));

      const results = await awaitBatch('batch_mixed', { _sleep: mockSleep });

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[0].content).toBe('OK');
      expect(results[1].success).toBe(false);
      expect(results[1].error).toContain('server_error');
    });
  });

  describe('runBatch', () => {
    it('submits and awaits in one call', async () => {
      mockBatchesCreate.mockResolvedValue({ id: 'batch_run' });
      mockBatchesRetrieve.mockResolvedValue({ processing_status: 'ended' });
      mockBatchesResults.mockResolvedValue(makeAsyncIterable([
        {
          custom_id: 'req-0',
          result: {
            type: 'succeeded',
            message: { content: [{ type: 'text', text: 'Combined result' }] },
          },
        },
      ]));

      const results = await runBatch(makeBatchRequests(1), { _sleep: mockSleep });

      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('Combined result');
      expect(mockBatchesCreate).toHaveBeenCalledOnce();
      expect(mockBatchesRetrieve).toHaveBeenCalledWith('batch_run');
    });
  });
});

/**
 * Helper to create an async iterable from an array (mimics SDK response stream).
 */
function makeAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < items.length) {
            return { value: items[index++], done: false };
          }
          return { value: undefined as unknown as T, done: true };
        },
      };
    },
  };
}
