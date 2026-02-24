/**
 * Spec Compliance Tool — compare implemented code against plan acceptance criteria.
 *
 * Two-stage review protocol:
 * 1. spec_compliance: check code against acceptance criteria (this tool)
 * 2. Then run code-reviewer + security-reviewer for quality review
 *
 * Zero-cost: reads plan store + git diff, no AI calls.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFileSync } from 'child_process';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { getConfig } from '../../config/paths.js';
import { loadFindings, recordFindings, type ReviewFinding } from './review-tracker.js';
import { randomUUID } from 'crypto';

interface CriterionResult {
  criterion: string;
  status: 'met' | 'partial' | 'not_met' | 'unknown';
  evidence: string;
}

/**
 * Check if a file was modified in the git diff (compared to main).
 */
function getChangedFiles(): string[] {
  try {
    const output = execFileSync('git', ['diff', '--name-only', 'main...HEAD'], {
      encoding: 'utf-8',
      cwd: getConfig().radlOpsDir,
      timeout: 10000,
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if a pattern exists in changed files.
 */
function grepChangedFiles(pattern: string, changedFiles: string[]): boolean {
  if (changedFiles.length === 0) return false;
  const radlDir = getConfig().radlOpsDir;
  try {
    execFileSync('grep', ['-l', '-r', '-E', pattern, ...changedFiles.map(f => `${radlDir}/${f}`)], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Auto-check acceptance criteria against changed files.
 * Uses heuristics: file presence, pattern matching, test existence.
 */
function checkCriterion(criterion: string, changedFiles: string[]): CriterionResult {
  const lower = criterion.toLowerCase();

  // Check for file-related criteria
  const fileMatch = criterion.match(/`([^`]+\.(ts|tsx|js|json|sql))`/);
  if (fileMatch) {
    const file = fileMatch[1];
    const found = changedFiles.some(f => f.includes(file) || f.endsWith(file));
    return {
      criterion,
      status: found ? 'met' : 'not_met',
      evidence: found ? `File ${file} was modified` : `File ${file} was NOT modified`,
    };
  }

  // Check for test-related criteria
  if (lower.includes('test') && (lower.includes('pass') || lower.includes('written') || lower.includes('added'))) {
    const hasTestFiles = changedFiles.some(f => f.includes('.test.') || f.includes('.spec.'));
    return {
      criterion,
      status: hasTestFiles ? 'met' : 'not_met',
      evidence: hasTestFiles ? 'Test files were modified' : 'No test files were modified',
    };
  }

  // Check for typecheck criteria
  if (lower.includes('typecheck') || lower.includes('type check') || lower.includes('tsc')) {
    return { criterion, status: 'unknown', evidence: 'Run verify level 4 for typecheck confirmation' };
  }

  // Default: unknown — requires manual check
  return { criterion, status: 'unknown', evidence: 'Requires manual verification' };
}

export function registerSpecComplianceTools(server: McpServer): void {
  server.tool(
    'spec_compliance',
    'Check implemented code against acceptance criteria. First stage of the two-stage review protocol: spec compliance check, then code + security review. Zero-cost (git diff analysis only).',
    {
      criteria: z.array(z.string().min(1).max(500)).min(1).max(20)
        .describe('Acceptance criteria to check (from sprint plan)'),
      task_id: z.number().optional()
        .describe('Task ID this compliance check is for (for tracking)'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    withErrorTracking('spec_compliance', async ({ criteria, task_id }) => {
      const changedFiles = getChangedFiles();

      const results = criteria.map(c => checkCriterion(c, changedFiles));

      const met = results.filter(r => r.status === 'met').length;
      const notMet = results.filter(r => r.status === 'not_met').length;
      const unknown = results.filter(r => r.status === 'unknown').length;
      const partial = results.filter(r => r.status === 'partial').length;

      // Record non-met criteria as review findings
      const failedCriteria = results.filter(r => r.status === 'not_met');
      if (failedCriteria.length > 0) {
        const now = new Date().toISOString();
        const findings: ReviewFinding[] = failedCriteria.map(r => ({
          id: randomUUID().substring(0, 8),
          severity: 'HIGH' as const,
          file: 'spec-compliance',
          description: `Criterion not met: ${r.criterion} — ${r.evidence}`,
          reviewer: 'spec-compliance',
          resolved: false,
          recordedAt: now,
        }));
        recordFindings(findings);
      }

      const statusIcon = (s: CriterionResult['status']): string => {
        switch (s) {
          case 'met': return '[MET]';
          case 'partial': return '[PARTIAL]';
          case 'not_met': return '[NOT MET]';
          case 'unknown': return '[?]';
        }
      };

      const lines: string[] = [
        `Spec Compliance: ${met}/${results.length} met${notMet > 0 ? `, ${notMet} NOT MET` : ''}${unknown > 0 ? `, ${unknown} unknown` : ''}${partial > 0 ? `, ${partial} partial` : ''}`,
        task_id !== undefined ? `Task: #${task_id}` : '',
        `Changed files: ${changedFiles.length}`,
        '',
      ];

      for (const r of results) {
        lines.push(`${statusIcon(r.status)} ${r.criterion}`);
        lines.push(`  ${r.evidence}`);
      }

      if (notMet > 0) {
        lines.push('');
        lines.push(`ACTION REQUIRED: ${notMet} criterion(s) not met. Fix before proceeding to code review.`);
      } else if (unknown > 0) {
        lines.push('');
        lines.push(`NOTE: ${unknown} criterion(s) require manual verification.`);
      }

      logger.info('Spec compliance check', { met, notMet, unknown, partial, task_id });

      return { content: [{ type: 'text' as const, text: lines.filter(Boolean).join('\n') }] };
    })
  );
}
