/**
 * Loop Guard - Detect and prevent repeated tool call patterns
 *
 * Based on OpenFang research: track repeated tool calls, detect ping-pong
 * patterns, and circuit-break runaway loops before they waste tokens.
 *
 * Tracks (toolName, paramHash) tuples and (callHash, resultHash) for
 * outcome-aware escalation. Detects A-B-A-B and A-B-C-A-B-C patterns.
 */

import { createHash } from 'crypto';
import { logger } from '../config/logger.js';

// Types
export interface LoopGuardResult {
  action: 'allow' | 'warn' | 'block';
  reason?: string;
  callCount: number;
}

interface CallHistoryEntry {
  readonly toolName: string;
  readonly paramHash: string;
  resultHash?: string;
}

// Internal state
const callHistory: CallHistoryEntry[] = [];
const callCounts = new Map<string, number>();
const outcomeAwareCounts = new Map<string, number>();
let totalLoopsDetected = 0;

const WARN_THRESHOLD = 3;
const BLOCK_THRESHOLD = 5;
const GLOBAL_CIRCUIT_BREAK = 30;
const HISTORY_WINDOW = 30;

function hashParams(params: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(params ?? {}))
    .digest('hex')
    .substring(0, 16);
}

/**
 * Check if a tool call should be allowed, warned, or blocked.
 * Call BEFORE executing the tool.
 */
export function checkToolCall(toolName: string, params: unknown): LoopGuardResult {
  const paramHash = hashParams(params);
  const callKey = `${toolName}:${paramHash}`;

  // Global circuit break
  if (totalLoopsDetected >= GLOBAL_CIRCUIT_BREAK) {
    return {
      action: 'block',
      reason: `Global circuit break: ${totalLoopsDetected} loops detected in session`,
      callCount: totalLoopsDetected,
    };
  }

  // Track call
  callHistory.push({ toolName, paramHash });
  if (callHistory.length > HISTORY_WINDOW * 2) {
    callHistory.splice(0, callHistory.length - HISTORY_WINDOW);
  }

  // Increment call count
  const count = (callCounts.get(callKey) ?? 0) + 1;
  callCounts.set(callKey, count);

  // Check ping-pong (A-B-A-B or A-B-C-A-B-C pattern in last 30 calls)
  const pingPong = detectPingPong();
  if (pingPong) {
    totalLoopsDetected++;
    return {
      action: 'warn',
      reason: `Ping-pong pattern detected: ${pingPong}`,
      callCount: count,
    };
  }

  // Check thresholds
  if (count >= BLOCK_THRESHOLD) {
    totalLoopsDetected++;
    return {
      action: 'block',
      reason: `Tool "${toolName}" called ${count} times with same params (blocked at ${BLOCK_THRESHOLD})`,
      callCount: count,
    };
  }

  if (count >= WARN_THRESHOLD) {
    totalLoopsDetected++;
    return {
      action: 'warn',
      reason: `Tool "${toolName}" called ${count} times with same params (warning at ${WARN_THRESHOLD})`,
      callCount: count,
    };
  }

  return { action: 'allow', callCount: count };
}

/**
 * Record the result of a tool call for outcome-aware escalation.
 * Call AFTER the tool executes.
 */
export function recordToolResult(toolName: string, params: unknown, result: unknown): void {
  const paramHash = hashParams(params);
  const resultHash = hashParams(result);
  const outcomeKey = `${toolName}:${paramHash}:${resultHash}`;

  // Update last history entry with result (immutable replacement)
  if (callHistory.length > 0) {
    const last = callHistory[callHistory.length - 1];
    if (last.toolName === toolName && last.paramHash === paramHash) {
      callHistory[callHistory.length - 1] = { ...last, resultHash };
    }
  }

  // Outcome-aware: same call + same result escalates faster
  const outcomeCount = (outcomeAwareCounts.get(outcomeKey) ?? 0) + 1;
  outcomeAwareCounts.set(outcomeKey, outcomeCount);

  // Escalate: same call + same result = reduced thresholds
  if (outcomeCount >= WARN_THRESHOLD - 1) {
    const callKey = `${toolName}:${paramHash}`;
    const currentCount = callCounts.get(callKey) ?? 0;
    if (currentCount < BLOCK_THRESHOLD) {
      logger.warn('Loop guard: outcome-aware escalation', {
        toolName,
        outcomeCount,
        reason: 'Same call producing same result repeatedly',
      });
    }
  }
}

/**
 * Detect A-B-A-B or A-B-C-A-B-C patterns in recent call history.
 */
function detectPingPong(): string | null {
  const recent = callHistory.slice(-HISTORY_WINDOW);
  if (recent.length < 4) return null;

  const keys = recent.map((c) => `${c.toolName}:${c.paramHash}`);

  // Check for repeating cycles of period 2 and 3
  for (const period of [2, 3]) {
    if (keys.length < period * 2) continue;
    const tail = keys.slice(-period * 2);
    const firstHalf = tail.slice(0, period).join(',');
    const secondHalf = tail.slice(period).join(',');
    if (firstHalf === secondHalf) {
      const pattern = tail
        .slice(0, period)
        .map((k) => k.split(':')[0])
        .join(' -> ');
      return `${pattern} (repeated ${period}-step cycle)`;
    }
  }

  return null;
}

/**
 * Reset the loop guard (call at session/sprint start).
 */
export function resetLoopGuard(): void {
  callHistory.length = 0;
  callCounts.clear();
  outcomeAwareCounts.clear();
  totalLoopsDetected = 0;
}

/**
 * Get current loop guard stats for diagnostics.
 */
export function getLoopGuardStats(): {
  totalCalls: number;
  uniqueCalls: number;
  loopsDetected: number;
  topRepeaters: Array<{ call: string; count: number }>;
} {
  const topRepeaters = Array.from(callCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([call, count]) => ({ call, count }));

  return {
    totalCalls: callHistory.length,
    uniqueCalls: callCounts.size,
    loopsDetected: totalLoopsDetected,
    topRepeaters,
  };
}
