/**
 * Review Tracker — records and resolves review findings per sprint.
 *
 * Storage: knowledge/sprint-reviews.json
 * Cleared at sprint_start, checked at sprint_complete.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { getConfig } from '../../config/paths.js';

export interface ReviewFinding {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  file: string;
  description: string;
  reviewer: string;
  resolved: boolean;
  resolution?: 'fixed' | 'deferred' | 'wont-fix';
  recordedAt: string;
  resolvedAt?: string;
}

interface ReviewStore {
  findings: ReviewFinding[];
}

function getStorePath(): string {
  return join(getConfig().knowledgeDir, 'sprint-reviews.json');
}

export function loadFindings(): ReviewFinding[] {
  const path = getStorePath();
  if (!existsSync(path)) return [];
  try {
    const store: ReviewStore = JSON.parse(readFileSync(path, 'utf-8'));
    return store.findings || [];
  } catch {
    return [];
  }
}

function saveFindings(findings: ReviewFinding[]): void {
  const store: ReviewStore = { findings };
  const targetPath = getStorePath();
  const tmpPath = `${targetPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(store, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, targetPath);
}

export function recordFindings(findings: ReviewFinding[]): void {
  const existing = loadFindings();
  saveFindings([...existing, ...findings]);
  logger.info('Review findings recorded', { count: findings.length });
}

export function resolveFindings(ids: string[], resolution: 'fixed' | 'deferred' | 'wont-fix'): number {
  const findings = loadFindings();
  let resolved = 0;
  const now = new Date().toISOString();
  const updated = findings.map(f => {
    if (ids.includes(f.id) && !f.resolved) {
      resolved++;
      return { ...f, resolved: true, resolution, resolvedAt: now };
    }
    return f;
  });
  saveFindings(updated);
  logger.info('Review findings resolved', { count: resolved, resolution });
  return resolved;
}

export function clearFindings(): void {
  const path = getStorePath();
  if (existsSync(path)) {
    saveFindings([]);
    logger.info('Review findings cleared for new sprint');
  }
}

export function checkUnresolved(): { critical: number; high: number; medium: number; low: number } {
  const findings = loadFindings();
  const unresolved = findings.filter(f => !f.resolved);
  return {
    critical: unresolved.filter(f => f.severity === 'CRITICAL').length,
    high: unresolved.filter(f => f.severity === 'HIGH').length,
    medium: unresolved.filter(f => f.severity === 'MEDIUM').length,
    low: unresolved.filter(f => f.severity === 'LOW').length,
  };
}

export function registerReviewTrackerTools(server: McpServer): void {
  server.tool(
    'record_review',
    'Record review findings from code-reviewer or security-reviewer agents. Call after each review to track findings.',
    {
      findings: z.array(z.object({
        severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
        file: z.string().min(1).describe('File path where finding was detected'),
        description: z.string().min(1).max(500).describe('Description of the finding'),
        reviewer: z.string().min(1).max(50).describe('Reviewer name (e.g., "security-reviewer", "code-reviewer")'),
      })).min(1).describe('Array of review findings to record'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    withErrorTracking('record_review', async ({ findings }) => {
      const now = new Date().toISOString();
      const newFindings: ReviewFinding[] = findings.map(f => ({
        id: randomUUID().substring(0, 8),
        severity: f.severity,
        file: f.file,
        description: f.description,
        reviewer: f.reviewer,
        resolved: false,
        recordedAt: now,
      }));

      recordFindings(newFindings);

      const summary = {
        critical: newFindings.filter(f => f.severity === 'CRITICAL').length,
        high: newFindings.filter(f => f.severity === 'HIGH').length,
        medium: newFindings.filter(f => f.severity === 'MEDIUM').length,
        low: newFindings.filter(f => f.severity === 'LOW').length,
      };

      const lines = [
        `Recorded ${newFindings.length} review findings:`,
        `  CRITICAL: ${summary.critical} | HIGH: ${summary.high} | MEDIUM: ${summary.medium} | LOW: ${summary.low}`,
        '',
        ...newFindings.map(f => `  [${f.severity}] ${f.id} — ${f.file}: ${f.description}`),
        '',
        'Use resolve_review to mark findings as addressed.',
      ];

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    })
  );

  server.tool(
    'resolve_review',
    'Mark review findings as resolved. Call after fixing issues flagged by reviewers.',
    {
      ids: z.array(z.string()).min(1).describe('Finding IDs to resolve'),
      resolution: z.enum(['fixed', 'deferred', 'wont-fix']).describe('How the finding was resolved'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    withErrorTracking('resolve_review', async ({ ids, resolution }) => {
      const count = resolveFindings(ids, resolution);
      const unresolved = checkUnresolved();
      const remaining = unresolved.critical + unresolved.high + unresolved.medium + unresolved.low;

      const text = `Resolved ${count} finding(s) as "${resolution}". Remaining unresolved: ${remaining} (${unresolved.critical} CRITICAL, ${unresolved.high} HIGH)`;
      return { content: [{ type: 'text' as const, text }] };
    })
  );
}
