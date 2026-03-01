import { describe, it, expect, beforeEach } from 'vitest';
import { withErrorTracking } from './with-error-tracking.js';
import { clearError, getErrorCount } from '../guardrails/iron-laws.js';
import { resetLoopGuard } from '../guardrails/loop-guard.js';

describe('withErrorTracking', () => {
  const toolName = 'test_tool';

  beforeEach(() => {
    clearError(toolName);
    clearError('other_tool');
    resetLoopGuard();
  });

  it('returns handler result on success', async () => {
    const handler = async () => ({
      content: [{ type: 'text' as const, text: 'OK' }],
    });
    const wrapped = withErrorTracking(toolName, handler);
    const result = await wrapped({});

    expect(result.content[0].text).toBe('OK');
  });

  it('clears error count on success', async () => {
    // Simulate a prior failure
    const failHandler = async () => { throw new Error('fail'); };
    const wrapped = withErrorTracking(toolName, failHandler);
    await wrapped({});
    expect(getErrorCount(toolName)).toBe(1);

    // Now succeed
    const successHandler = async () => ({
      content: [{ type: 'text' as const, text: 'OK' }],
    });
    const wrappedSuccess = withErrorTracking(toolName, successHandler);
    await wrappedSuccess({});

    expect(getErrorCount(toolName)).toBe(0);
  });

  it('returns error message with strike count on failure', async () => {
    const handler = async () => { throw new Error('API timeout'); };
    const wrapped = withErrorTracking(toolName, handler);
    const result = await wrapped({});

    expect(result.content[0].text).toContain('**ERROR** (strike 1/3)');
    expect(result.content[0].text).toContain('API timeout');
  });

  it('increments strike count on consecutive failures', async () => {
    const handler = async () => { throw new Error('fail'); };
    const wrapped = withErrorTracking(toolName, handler);

    await wrapped({});
    expect(getErrorCount(toolName)).toBe(1);

    await wrapped({});
    expect(getErrorCount(toolName)).toBe(2);
  });

  it('returns 3-strike escalation after 3 failures', async () => {
    const handler = async () => { throw new Error('persistent failure'); };
    const wrapped = withErrorTracking(toolName, handler);

    await wrapped({});
    await wrapped({});
    const result = await wrapped({});

    expect(result.content[0].text).toContain('**3-STRIKE LIMIT REACHED**');
    expect(result.content[0].text).toContain('Failed 3 times');
    expect(result.content[0].text).toContain('Do NOT retry');
    expect(result.content[0].text).toContain('persistent failure');
  });

  it('tracks different tool names independently', async () => {
    const failHandler = async () => { throw new Error('fail'); };

    const wrapped1 = withErrorTracking(toolName, failHandler);
    const wrapped2 = withErrorTracking('other_tool', failHandler);

    await wrapped1({});
    await wrapped1({});
    await wrapped2({});

    expect(getErrorCount(toolName)).toBe(2);
    expect(getErrorCount('other_tool')).toBe(1);
  });

  it('resets strike count after success following failures', async () => {
    let shouldFail = true;
    const handler = async () => {
      if (shouldFail) throw new Error('fail');
      return { content: [{ type: 'text' as const, text: 'OK' }] };
    };
    const wrapped = withErrorTracking(toolName, handler);

    await wrapped({});
    await wrapped({});
    expect(getErrorCount(toolName)).toBe(2);

    shouldFail = false;
    await wrapped({});
    expect(getErrorCount(toolName)).toBe(0);
  });

  it('handles non-Error thrown values', async () => {
    const handler = async () => { throw 'string error'; };
    const wrapped = withErrorTracking(toolName, handler);
    const result = await wrapped({});

    expect(result.content[0].text).toContain('Unknown error');
  });

  it('passes params through to handler', async () => {
    let receivedParams: unknown;
    const handler = async (params: { name: string }) => {
      receivedParams = params;
      return { content: [{ type: 'text' as const, text: 'OK' }] };
    };
    const wrapped = withErrorTracking(toolName, handler);
    await wrapped({ name: 'test' });

    expect(receivedParams).toEqual({ name: 'test' });
  });

  describe('loop guard integration', () => {
    it('passes through when loop guard allows', async () => {
      const handler = async () => ({
        content: [{ type: 'text' as const, text: 'OK' }],
      });
      const wrapped = withErrorTracking('unique_tool', handler);
      const result = await wrapped({ key: 'value' });

      expect(result.content[0].text).toBe('OK');
      expect(result.isError).toBeUndefined();
    });

    it('returns error when loop guard blocks (global circuit break)', async () => {
      const handler = async () => ({
        content: [{ type: 'text' as const, text: 'OK' }],
      });
      const wrapped = withErrorTracking('repeated_tool', handler);
      const params = { same: 'params' };

      // Identical calls trigger ping-pong warnings (not count-based blocks),
      // each incrementing totalLoopsDetected. After GLOBAL_CIRCUIT_BREAK (30)
      // loops detected, the guard blocks.
      // Call 3 warns (count threshold), calls 4+ warn (ping-pong), so
      // totalLoopsDetected reaches 30 after ~32 calls. Call 33 is blocked.
      for (let i = 0; i < 32; i++) {
        await wrapped(params);
      }

      // 33rd call should be blocked by global circuit break
      const result = await wrapped(params);
      expect(result.content[0].text).toContain('LOOP GUARD BLOCKED');
      expect(result.isError).toBe(true);
    });

    it('logs warning when loop guard warns (3+ identical calls)', async () => {
      const handler = async () => ({
        content: [{ type: 'text' as const, text: 'OK' }],
      });
      const wrapped = withErrorTracking('warn_tool', handler);
      const params = { same: 'params' };

      // First 2 calls are fine
      await wrapped(params);
      await wrapped(params);

      // 3rd call should warn but still return OK
      const result = await wrapped(params);
      expect(result.content[0].text).toBe('OK');
      expect(result.isError).toBeUndefined();
    });

    it('records tool results for outcome-aware escalation', async () => {
      let callCount = 0;
      const handler = async () => {
        callCount++;
        return { content: [{ type: 'text' as const, text: `Result ${callCount}` }] };
      };
      const wrapped = withErrorTracking('outcome_tool', handler);

      const result = await wrapped({ test: true });
      expect(result.content[0].text).toBe('Result 1');
      // No crash = recordToolResult was called successfully
    });

    it('existing error tracking still works with loop guard', async () => {
      const handler = async () => { throw new Error('API failure'); };
      const wrapped = withErrorTracking('error_with_guard', handler);

      const result = await wrapped({});
      expect(result.content[0].text).toContain('**ERROR** (strike 1/3)');
      expect(getErrorCount('error_with_guard')).toBe(1);
    });
  });
});
