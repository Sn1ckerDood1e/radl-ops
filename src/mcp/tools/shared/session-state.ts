/**
 * Session state store — shared between session-health tool and error tracking.
 *
 * Separated from session-health.ts to avoid circular dependency:
 * with-error-tracking → session-health → with-error-tracking
 */

interface ToolCallRecord {
  tool: string;
  timestamp: number;
  success: boolean;
}

export interface SessionMetrics {
  startedAt: number;
  toolCalls: ToolCallRecord[];
  commitCount: number;
  lastCommitAt: number | null;
  lastProgressAt: number | null;
  sprintActive: boolean;
}

// In-memory session state (reset on server restart = new session)
export const session: SessionMetrics = {
  startedAt: Date.now(),
  toolCalls: [],
  commitCount: 0,
  lastCommitAt: null,
  lastProgressAt: null,
  sprintActive: false,
};

/**
 * Record a tool call. Called from withErrorTracking wrapper.
 */
export function recordToolCall(tool: string, success: boolean): void {
  session.toolCalls.push({
    tool,
    timestamp: Date.now(),
    success,
  });

  if (tool === 'sprint_start') {
    session.sprintActive = true;
  }
  if (tool === 'sprint_complete') {
    session.sprintActive = false;
  }
  if (tool === 'sprint_progress') {
    session.lastProgressAt = Date.now();
  }
}

/**
 * Record a git commit event.
 */
export function recordCommit(): void {
  session.commitCount++;
  session.lastCommitAt = Date.now();
}
