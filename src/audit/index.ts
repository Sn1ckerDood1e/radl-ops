/**
 * Audit Logging System
 *
 * All actions are logged for security review.
 * Based on OWASP 2025 recommendations and OpenClaw security analysis.
 *
 * Features:
 * - Immutable audit trail
 * - JSON Lines format for easy parsing
 * - Configurable retention
 * - Query capabilities
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AuditEntry, AuditAction, PermissionTier } from '../types/index.js';
import { logger } from '../config/logger.js';

const AUDIT_DIR = process.env.AUDIT_LOG_DIR || './audit-logs';
const MAX_FILE_SIZE_MB = 10;
const RETENTION_DAYS = 90;

/**
 * Ensure audit directory exists
 */
function ensureAuditDir(): void {
  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
  }
}

/**
 * Get current audit log filename (daily rotation)
 */
function getLogFilename(): string {
  const date = new Date().toISOString().split('T')[0];
  return path.join(AUDIT_DIR, `audit-${date}.jsonl`);
}

/**
 * Generate unique audit entry ID
 */
function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `audit_${timestamp}_${random}`;
}

/**
 * Log an audit entry
 */
export function audit(
  action: AuditAction,
  details: Omit<AuditEntry, 'id' | 'timestamp' | 'action'>
): AuditEntry {
  ensureAuditDir();

  const entry: AuditEntry = {
    id: generateId(),
    timestamp: new Date(),
    action,
    ...details,
  };

  const filename = getLogFilename();
  const line = JSON.stringify(entry) + '\n';

  try {
    fs.appendFileSync(filename, line);

    // Also log to standard logger for immediate visibility
    const logLevel = getLogLevelForAction(action, entry.result);
    logger[logLevel](`AUDIT: ${action}`, {
      tool: entry.tool,
      tier: entry.permissionTier,
      result: entry.result,
      userId: entry.userId,
    });
  } catch (error) {
    // Audit logging failure is critical - log to stderr as backup
    console.error('AUDIT LOG FAILURE:', error);
    console.error('AUDIT ENTRY:', JSON.stringify(entry));
  }

  return entry;
}

/**
 * Determine log level based on action and result
 */
function getLogLevelForAction(
  action: AuditAction,
  result?: 'success' | 'failure' | 'pending'
): 'info' | 'warn' | 'error' {
  // Failures are always warnings or errors
  if (result === 'failure') {
    return action.includes('blocked') || action.includes('denied') ? 'warn' : 'error';
  }

  // Security-sensitive actions are warnings
  if (
    action === 'approval_requested' ||
    action === 'rate_limited' ||
    action === 'validation_failed'
  ) {
    return 'warn';
  }

  return 'info';
}

// ============================================
// Convenience Functions
// ============================================

export function auditToolExecution(
  tool: string,
  permissionTier: PermissionTier,
  channel: string,
  params: Record<string, unknown>,
  result: 'success' | 'failure',
  error?: string,
  metadata?: Record<string, unknown>
): AuditEntry {
  return audit('tool_executed', {
    tool,
    permissionTier,
    channel,
    params: sanitizeParams(params),
    result,
    error,
    metadata,
  });
}

export function auditToolBlocked(
  tool: string,
  permissionTier: PermissionTier,
  channel: string,
  reason: string,
  userId?: string
): AuditEntry {
  return audit('tool_blocked', {
    tool,
    permissionTier,
    channel,
    userId,
    result: 'failure',
    error: reason,
  });
}

export function auditApprovalRequested(
  tool: string,
  permissionTier: PermissionTier,
  channel: string,
  conversationId: string,
  params: Record<string, unknown>
): AuditEntry {
  return audit('approval_requested', {
    tool,
    permissionTier,
    channel,
    conversationId,
    params: sanitizeParams(params),
    result: 'pending',
  });
}

export function auditApprovalResponse(
  tool: string,
  approved: boolean,
  approvedBy: string,
  channel: string
): AuditEntry {
  return audit(approved ? 'approval_granted' : 'approval_denied', {
    tool,
    channel,
    userId: approvedBy,
    result: approved ? 'success' : 'failure',
  });
}

export function auditRateLimited(
  tool: string,
  channel: string,
  userId?: string
): AuditEntry {
  return audit('rate_limited', {
    tool,
    channel,
    userId,
    result: 'failure',
    error: 'Rate limit exceeded',
  });
}

export function auditValidationFailed(
  tool: string,
  channel: string,
  validationErrors: string[]
): AuditEntry {
  return audit('validation_failed', {
    tool,
    channel,
    result: 'failure',
    error: validationErrors.join('; '),
  });
}

// ============================================
// Query Functions
// ============================================

export interface AuditQuery {
  startDate?: Date;
  endDate?: Date;
  actions?: AuditAction[];
  tools?: string[];
  userId?: string;
  channel?: string;
  result?: 'success' | 'failure' | 'pending';
  limit?: number;
}

/**
 * Query audit logs (for review/debugging)
 */
export async function queryAuditLogs(query: AuditQuery = {}): Promise<AuditEntry[]> {
  ensureAuditDir();

  const results: AuditEntry[] = [];
  const limit = query.limit || 100;

  // Get list of log files
  const files = fs.readdirSync(AUDIT_DIR)
    .filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'))
    .sort()
    .reverse(); // Most recent first

  for (const file of files) {
    // Check date range
    const fileDate = file.replace('audit-', '').replace('.jsonl', '');
    if (query.startDate && fileDate < query.startDate.toISOString().split('T')[0]) {
      continue;
    }
    if (query.endDate && fileDate > query.endDate.toISOString().split('T')[0]) {
      continue;
    }

    // Read and parse file
    const filepath = path.join(AUDIT_DIR, file);
    const content = fs.readFileSync(filepath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AuditEntry;

        // Apply filters
        if (query.actions && !query.actions.includes(entry.action)) continue;
        if (query.tools && entry.tool && !query.tools.includes(entry.tool)) continue;
        if (query.userId && entry.userId !== query.userId) continue;
        if (query.channel && entry.channel !== query.channel) continue;
        if (query.result && entry.result !== query.result) continue;

        results.push(entry);

        if (results.length >= limit) {
          return results;
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  return results;
}

/**
 * Get audit summary for a time period
 */
export async function getAuditSummary(
  startDate: Date,
  endDate: Date = new Date()
): Promise<{
  totalActions: number;
  byAction: Record<string, number>;
  byTool: Record<string, number>;
  byResult: Record<string, number>;
  approvalStats: {
    requested: number;
    granted: number;
    denied: number;
    expired: number;
  };
}> {
  const entries = await queryAuditLogs({ startDate, endDate, limit: 10000 });

  const summary = {
    totalActions: entries.length,
    byAction: {} as Record<string, number>,
    byTool: {} as Record<string, number>,
    byResult: {} as Record<string, number>,
    approvalStats: {
      requested: 0,
      granted: 0,
      denied: 0,
      expired: 0,
    },
  };

  for (const entry of entries) {
    // By action
    summary.byAction[entry.action] = (summary.byAction[entry.action] || 0) + 1;

    // By tool
    if (entry.tool) {
      summary.byTool[entry.tool] = (summary.byTool[entry.tool] || 0) + 1;
    }

    // By result
    if (entry.result) {
      summary.byResult[entry.result] = (summary.byResult[entry.result] || 0) + 1;
    }

    // Approval stats
    if (entry.action === 'approval_requested') summary.approvalStats.requested++;
    if (entry.action === 'approval_granted') summary.approvalStats.granted++;
    if (entry.action === 'approval_denied') summary.approvalStats.denied++;
    if (entry.action === 'approval_expired') summary.approvalStats.expired++;
  }

  return summary;
}

// ============================================
// Cleanup Functions
// ============================================

/**
 * Clean up old audit logs (run periodically)
 */
export function cleanupOldLogs(): number {
  ensureAuditDir();

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
  const cutoff = cutoffDate.toISOString().split('T')[0];

  let deletedCount = 0;

  const files = fs.readdirSync(AUDIT_DIR)
    .filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'));

  for (const file of files) {
    const fileDate = file.replace('audit-', '').replace('.jsonl', '');
    if (fileDate < cutoff) {
      fs.unlinkSync(path.join(AUDIT_DIR, file));
      deletedCount++;
      logger.info(`Deleted old audit log: ${file}`);
    }
  }

  return deletedCount;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Remove sensitive data from params before logging
 */
function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const sensitive = ['password', 'token', 'secret', 'apikey', 'api_key', 'auth'];
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    const lowerKey = key.toLowerCase();
    if (sensitive.some(s => lowerKey.includes(s))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'string' && value.length > 500) {
      sanitized[key] = value.substring(0, 500) + '...[truncated]';
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
