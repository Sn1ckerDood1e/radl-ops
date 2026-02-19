/**
 * MCP Session Health Tracking Tool
 *
 * Tracks tool usage patterns within a session and detects unhealthy signals:
 * - Tool calls without commits (all talk, no code)
 * - Repeated identical tool calls (thrashing)
 * - Excessive search without action (analysis paralysis)
 * - Long gaps between sprint_progress calls
 * - High error rate (tools failing repeatedly)
 *
 * State is stored in shared/session-state.ts (avoids circular dependency).
 * Tool call recording happens automatically via withErrorTracking wrapper.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { session, recordToolCall, recordCommit } from './shared/session-state.js';

// Re-export for external consumers
export { recordToolCall, recordCommit };

interface HealthSignal {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  metric: string;
}

function analyzeSession(): HealthSignal[] {
  const signals: HealthSignal[] = [];
  const now = Date.now();
  const sessionMinutes = (now - session.startedAt) / (1000 * 60);

  if (sessionMinutes < 5) {
    return [{ id: 'too_early', severity: 'info', message: 'Session too young for meaningful analysis', metric: `${Math.round(sessionMinutes)}m` }];
  }

  const totalCalls = session.toolCalls.length;
  const last30min = session.toolCalls.filter(c => now - c.timestamp < 30 * 60 * 1000);

  // Signal 1: Tool calls without commits (coding stall)
  if (totalCalls > 15 && session.commitCount === 0 && sessionMinutes > 20) {
    signals.push({
      id: 'no_commits',
      severity: 'warning',
      message: `${totalCalls} tool calls in ${Math.round(sessionMinutes)}m with no commits. Are you stuck?`,
      metric: `${totalCalls} calls / 0 commits`,
    });
  }

  // Signal 2: Repeated identical tool calls (thrashing)
  const recentTools = last30min.map(c => c.tool);
  const toolFreq = new Map<string, number>();
  for (const t of recentTools) {
    toolFreq.set(t, (toolFreq.get(t) ?? 0) + 1);
  }
  for (const [tool, count] of toolFreq) {
    if (count >= 5 && !['sprint_progress', 'health_check', 'session_health'].includes(tool)) {
      signals.push({
        id: 'thrashing',
        severity: 'warning',
        message: `"${tool}" called ${count} times in last 30m. Possible thrashing — try a different approach.`,
        metric: `${count}x in 30m`,
      });
    }
  }

  // Signal 3: Consecutive identical tool calls (stuck loop)
  if (last30min.length >= 3) {
    let consecutiveCount = 1;
    for (let i = last30min.length - 1; i > 0; i--) {
      if (last30min[i].tool === last30min[i - 1].tool) {
        consecutiveCount++;
      } else {
        break;
      }
    }
    const lastTool = last30min[last30min.length - 1].tool;
    if (consecutiveCount >= 3 && !['sprint_progress', 'health_check', 'session_health'].includes(lastTool)) {
      signals.push({
        id: 'action_repetition',
        severity: consecutiveCount >= 5 ? 'critical' : 'warning',
        message: `"${lastTool}" called ${consecutiveCount} times consecutively. Likely stuck — try a different approach or escalate.`,
        metric: `${consecutiveCount}x consecutive`,
      });
    }
  }

  // Signal 4: High error rate
  const recentErrors = last30min.filter(c => !c.success).length;
  const recentTotal = last30min.length;
  if (recentTotal >= 5 && recentErrors / recentTotal > 0.4) {
    signals.push({
      id: 'high_error_rate',
      severity: 'critical',
      message: `${recentErrors}/${recentTotal} tool calls failed in last 30m (${Math.round(recentErrors / recentTotal * 100)}% error rate). Check for systemic issues.`,
      metric: `${Math.round(recentErrors / recentTotal * 100)}% failure`,
    });
  }

  // Signal 5: Sprint active but no progress recorded
  if (session.sprintActive) {
    if (session.lastProgressAt) {
      const minutesSinceProgress = (now - session.lastProgressAt) / (1000 * 60);
      if (minutesSinceProgress > 45) {
        signals.push({
          id: 'stale_progress',
          severity: 'warning',
          message: `Sprint active but no progress recorded in ${Math.round(minutesSinceProgress)}m. Run sprint_progress or checkpoint.`,
          metric: `${Math.round(minutesSinceProgress)}m since last update`,
        });
      }
    } else if (sessionMinutes > 45) {
      signals.push({
        id: 'stale_progress',
        severity: 'warning',
        message: `Sprint active but sprint_progress never called (${Math.round(sessionMinutes)}m). Log your first milestone.`,
        metric: `${Math.round(sessionMinutes)}m, no progress logged`,
      });
    }
  }

  // Signal 6: Commits made without sprint tracking active
  if (!session.sprintActive && session.commitCount > 0 && sessionMinutes > 10) {
    signals.push({
      id: 'no_sprint',
      severity: 'info',
      message: 'Commits without an active sprint. Consider starting sprint tracking.',
      metric: `${session.commitCount} commits, no sprint`,
    });
  }

  // Signal 7: Session duration warning
  if (sessionMinutes > 120) {
    signals.push({
      id: 'long_session',
      severity: 'info',
      message: `Session running for ${Math.round(sessionMinutes)}m. Consider context management (/strategic-compact).`,
      metric: `${Math.round(sessionMinutes)}m`,
    });
  }

  if (signals.length === 0) {
    signals.push({
      id: 'healthy',
      severity: 'info',
      message: 'Session looks healthy. No concerning patterns detected.',
      metric: `${totalCalls} calls, ${session.commitCount} commits in ${Math.round(sessionMinutes)}m`,
    });
  }

  return signals;
}

function formatHealthReport(signals: HealthSignal[]): string {
  const icon = (s: HealthSignal['severity']): string => {
    switch (s) {
      case 'info': return '[INFO]';
      case 'warning': return '[WARN]';
      case 'critical': return '[CRIT]';
    }
  };

  const now = Date.now();
  const sessionMinutes = Math.round((now - session.startedAt) / (1000 * 60));
  const critCount = signals.filter(s => s.severity === 'critical').length;
  const warnCount = signals.filter(s => s.severity === 'warning').length;

  const overall = critCount > 0 ? 'unhealthy'
    : warnCount >= 2 ? 'concerning'
    : warnCount === 1 ? 'minor_issues'
    : 'healthy';

  const lines: string[] = [
    `Session Health: **${overall}** (${sessionMinutes}m, ${session.toolCalls.length} tool calls, ${session.commitCount} commits)`,
    '',
  ];

  for (const signal of signals) {
    lines.push(`${icon(signal.severity)} ${signal.message}`);
  }

  return lines.join('\n');
}

export function registerSessionHealthTools(server: McpServer): void {
  server.tool(
    'session_health',
    'Analyze current session health. Detects thrashing, stalls, high error rates, missing sprint tracking. Zero-cost (in-memory analysis only).',
    {
      record_commit: z.boolean().optional()
        .describe('Set to true to record a git commit event (call this from commit hooks)'),
      record_tool: z.string().max(50).optional()
        .describe('Record a tool call event (tool name). Used by hook integration.'),
      record_success: z.boolean().optional()
        .describe('Whether the recorded tool call succeeded (default true)'),
    },
    { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    withErrorTracking('session_health', async ({ record_commit, record_tool, record_success }) => {
      // If recording events, just record and return minimal acknowledgment
      if (record_commit) {
        recordCommit();
        return {
          content: [{ type: 'text' as const, text: `Commit recorded (total: ${session.commitCount})` }],
        };
      }

      if (record_tool) {
        recordToolCall(record_tool, record_success ?? true);
        return {
          content: [{ type: 'text' as const, text: 'Tool call recorded.' }],
        };
      }

      // Default: analyze and report
      const signals = analyzeSession();
      const report = formatHealthReport(signals);

      logger.info('Session health check', {
        signals: signals.map(s => s.id),
        critCount: signals.filter(s => s.severity === 'critical').length,
        warnCount: signals.filter(s => s.severity === 'warning').length,
      });

      return {
        content: [{ type: 'text' as const, text: report }],
        structuredContent: {
          sessionDurationMinutes: Math.round((Date.now() - session.startedAt) / (1000 * 60)),
          totalToolCalls: session.toolCalls.length,
          commitCount: session.commitCount,
          sprintActive: session.sprintActive,
          signals,
        },
      };
    })
  );
}
