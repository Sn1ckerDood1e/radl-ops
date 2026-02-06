/**
 * Iron Laws - Hard constraints that the agent CANNOT override
 *
 * From research on AI agent failure modes:
 * - Architectural drift prevention (ArchCodex)
 * - "Documentation gets ignored. Constraints get executed."
 * - Hard rules must be enforced programmatically, not just instructed
 */

import { logger } from '../config/logger.js';
import { audit } from '../audit/index.js';

/**
 * An iron law that cannot be violated
 */
export interface IronLaw {
  id: string;
  description: string;
  /** Check function returns null if OK, or error message if violated */
  check: (context: LawCheckContext) => string | null;
  severity: 'block' | 'warn';
}

/**
 * Context for law checking
 */
export interface LawCheckContext {
  action: string;
  toolName?: string;
  params?: Record<string, unknown>;
  targetFile?: string;
  gitBranch?: string;
  errorCount?: number;
}

/**
 * Result of checking all iron laws
 */
export interface LawCheckResult {
  passed: boolean;
  violations: Array<{
    lawId: string;
    description: string;
    message: string;
    severity: 'block' | 'warn';
  }>;
}

/**
 * The iron laws. These are non-negotiable.
 */
const IRON_LAWS: IronLaw[] = [
  {
    id: 'no-push-main',
    description: 'Never push directly to main branch',
    severity: 'block',
    check: (ctx) => {
      if (
        ctx.action === 'git_push' &&
        (ctx.gitBranch === 'main' || ctx.gitBranch === 'master')
      ) {
        return 'Cannot push directly to main/master branch. Create a PR instead.';
      }
      return null;
    },
  },
  {
    id: 'no-delete-prod-data',
    description: 'Never delete production data',
    severity: 'block',
    check: (ctx) => {
      if (
        ctx.action === 'database_operation' &&
        ctx.params?.operation === 'delete' &&
        ctx.params?.environment === 'production'
      ) {
        return 'Cannot delete production data. This requires manual intervention.';
      }
      return null;
    },
  },
  {
    id: 'no-commit-secrets',
    description: 'Never commit secrets or credentials',
    severity: 'block',
    check: (ctx) => {
      if (ctx.action === 'file_write' && ctx.targetFile) {
        const sensitiveFiles = ['.env', '.env.local', 'credentials', 'secrets'];
        const isSensitive = sensitiveFiles.some(f =>
          ctx.targetFile!.toLowerCase().includes(f)
        );
        if (isSensitive && ctx.params?.isGitTracked) {
          return `Cannot commit sensitive file: ${ctx.targetFile}`;
        }
      }

      // Check content for common secret patterns
      if (ctx.action === 'file_write' && typeof ctx.params?.content === 'string') {
        const content = ctx.params.content as string;
        const secretPatterns = [
          /sk-[a-zA-Z0-9]{20,}/,                          // OpenAI/generic API keys
          /sk-ant-[a-zA-Z0-9-]{40,}/,                     // Anthropic keys
          /AKIA[0-9A-Z]{16}/,                              // AWS access keys
          /ghp_[a-zA-Z0-9]{36}/,                           // GitHub personal tokens
          /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/,   // GitHub PAT (fine-grained)
          /gho_[a-zA-Z0-9]{36}/,                           // GitHub OAuth tokens
          /xox[baprs]-[0-9a-zA-Z-]+/,                      // Slack tokens
          /AIza[0-9A-Za-z-_]{35}/,                         // Google API keys
          /(password|passwd|pwd)\s*[:=]\s*["'][^"']+["']/i, // Hardcoded passwords
          /[sS]ecret\s*[:=]\s*["'][^"']+["']/i,            // Secret assignments
          /[tT]oken\s*[:=]\s*["'][^"']+["']/i,             // Token assignments
          /-----BEGIN[\s\S]*PRIVATE KEY-----/,              // PEM private keys
          /Bearer\s+[a-zA-Z0-9._-]{20,}/,                  // Bearer tokens
          /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}/, // JWT tokens
          /(postgres|mysql|mongodb):\/\/[^:]+:[^@]+@/,      // Database URLs with creds
        ];

        for (const pattern of secretPatterns) {
          if (pattern.test(content)) {
            return `Possible secret detected in content. Pattern: ${pattern.source}`;
          }
        }
      }
      return null;
    },
  },
  {
    id: 'three-strike-escalation',
    description: 'After 3 failures on the same issue, stop and escalate',
    severity: 'block',
    check: (ctx) => {
      if (ctx.errorCount !== undefined && ctx.errorCount >= 3) {
        return `3-strike limit reached (${ctx.errorCount} failures). Stopping to escalate to user. Do not retry - explain what failed and ask for guidance.`;
      }
      return null;
    },
  },
  {
    id: 'no-modify-cicd',
    description: 'Never modify CI/CD pipelines without approval',
    severity: 'block',
    check: (ctx) => {
      if (ctx.action === 'file_write' && ctx.targetFile) {
        const cicdPaths = [
          '.github/workflows',
          '.gitlab-ci',
          'Jenkinsfile',
          '.circleci',
          'vercel.json',
        ];
        const isCiCd = cicdPaths.some(p => ctx.targetFile!.includes(p));
        if (isCiCd && !ctx.params?.explicitlyApproved) {
          return `Cannot modify CI/CD file without explicit approval: ${ctx.targetFile}`;
        }
      }
      return null;
    },
  },
  {
    id: 'no-force-push',
    description: 'Never force push',
    severity: 'block',
    check: (ctx) => {
      if (ctx.action === 'git_push' && ctx.params?.force) {
        return 'Force push is not allowed. Use regular push or create a new branch.';
      }
      return null;
    },
  },
];

/**
 * Check all iron laws against a given action context
 */
export function checkIronLaws(context: LawCheckContext): LawCheckResult {
  const violations: LawCheckResult['violations'] = [];

  for (const law of IRON_LAWS) {
    const violation = law.check(context);
    if (violation) {
      violations.push({
        lawId: law.id,
        description: law.description,
        message: violation,
        severity: law.severity,
      });

      // Audit the violation
      audit('tool_blocked', {
        tool: context.toolName ?? context.action,
        channel: 'system',
        result: 'failure',
        metadata: {
          ironLaw: law.id,
          violation,
          severity: law.severity,
        },
      });

      logger.warn('Iron law violation', {
        lawId: law.id,
        action: context.action,
        message: violation,
      });
    }
  }

  const hasBlockingViolation = violations.some(v => v.severity === 'block');

  return {
    passed: !hasBlockingViolation,
    violations,
  };
}

/**
 * Get all iron laws for display
 */
export function getIronLaws(): Array<{ id: string; description: string; severity: string }> {
  return IRON_LAWS.map(law => ({
    id: law.id,
    description: law.description,
    severity: law.severity,
  }));
}

/**
 * Error tracking for the 3-strike rule.
 * Tracks consecutive failures per action/issue key.
 * Includes TTL (1 hour) and max entries (1000) to prevent memory leaks.
 */
interface ErrorEntry {
  count: number;
  firstSeen: Date;
  lastSeen: Date;
}

const errorEntries = new Map<string, ErrorEntry>();
const MAX_ERROR_ENTRIES = 1000;
const ERROR_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Clean up expired error entries
 */
function cleanupErrorEntries(): void {
  const now = new Date();
  for (const [key, entry] of errorEntries) {
    if (now.getTime() - entry.lastSeen.getTime() > ERROR_TTL_MS) {
      errorEntries.delete(key);
    }
  }

  // Enforce max size by removing oldest entries
  if (errorEntries.size > MAX_ERROR_ENTRIES) {
    const sorted = Array.from(errorEntries.entries())
      .sort((a, b) => a[1].firstSeen.getTime() - b[1].firstSeen.getTime());
    const toRemove = sorted.slice(0, sorted.length - MAX_ERROR_ENTRIES);
    for (const [key] of toRemove) {
      errorEntries.delete(key);
    }
  }
}

/**
 * Record an error for 3-strike tracking.
 * Returns the current count after incrementing.
 */
export function recordError(issueKey: string): number {
  cleanupErrorEntries();
  const now = new Date();
  const existing = errorEntries.get(issueKey);

  if (existing) {
    const updated: ErrorEntry = {
      count: existing.count + 1,
      firstSeen: existing.firstSeen,
      lastSeen: now,
    };
    errorEntries.set(issueKey, updated);
    return updated.count;
  }

  errorEntries.set(issueKey, { count: 1, firstSeen: now, lastSeen: now });
  return 1;
}

/**
 * Clear error count for an issue (after successful resolution)
 */
export function clearError(issueKey: string): void {
  errorEntries.delete(issueKey);
}

/**
 * Get current error count for an issue
 */
export function getErrorCount(issueKey: string): number {
  const entry = errorEntries.get(issueKey);
  if (!entry) return 0;

  // Check if expired
  const now = new Date();
  if (now.getTime() - entry.lastSeen.getTime() > ERROR_TTL_MS) {
    errorEntries.delete(issueKey);
    return 0;
  }
  return entry.count;
}
