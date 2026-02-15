/**
 * MCP Deferred Item Lifecycle Tool
 *
 * Automates deferred item triage:
 * - Auto-close items where referenced files were deleted
 * - Escalate items older than 5 days
 * - Surface small-effort actionable items
 * - Report: total, auto-resolved, escalated, actionable
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { execFileSync } from 'child_process';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { getConfig } from '../../config/paths.js';

// ============================================
// Types
// ============================================

interface DeferredItem {
  id: number;
  title: string;
  reason: string;
  effort: string;
  sprintPhase: string;
  date: string;
  resolved: boolean;
}

interface DeferredStore {
  items: DeferredItem[];
}

export interface TriageResult {
  total: number;
  unresolved: number;
  autoResolved: DeferredItem[];
  escalated: DeferredItem[];
  actionable: DeferredItem[];
  alreadyResolved: number;
}

// ============================================
// Core Logic
// ============================================

function loadDeferred(knowledgeDir: string): DeferredStore {
  const path = `${knowledgeDir}/deferred.json`;
  if (!existsSync(path)) return { items: [] };

  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { items: [] };
  }
}

function saveDeferred(knowledgeDir: string, store: DeferredStore): void {
  const path = `${knowledgeDir}/deferred.json`;
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify(store, null, 2));
  renameSync(tempPath, path);
}

/**
 * Check if a deferred item's referenced files still exist in the codebase.
 * Uses grep on the radl codebase to find references.
 */
export function checkItemReferences(item: DeferredItem, radlDir: string): boolean {
  // Extract likely file or component names from title
  const keywords = item.title
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && /^[A-Z]/.test(w)); // PascalCase words likely = components/files

  if (keywords.length === 0) return true; // Can't determine — keep it

  // Check if any keyword matches a file in the codebase
  for (const keyword of keywords) {
    try {
      const result = execFileSync('grep', ['-rl', keyword, '--include=*.ts', '--include=*.tsx', '-m', '1', radlDir], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      if (result.trim()) return true; // Found a reference
    } catch {
      // grep returns non-zero when no match — continue
    }
  }

  return false; // No references found
}

/**
 * Calculate the age of an item in days.
 */
export function getItemAgeDays(item: DeferredItem): number {
  const created = new Date(item.date);
  const now = new Date();
  return Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Run the full deferred triage process.
 */
export function runDeferredTriage(knowledgeDir: string, radlDir: string, autoResolve: boolean): TriageResult {
  const store = loadDeferred(knowledgeDir);
  const total = store.items.length;
  const alreadyResolved = store.items.filter(i => i.resolved).length;
  const unresolved = store.items.filter(i => !i.resolved);

  const autoResolved: DeferredItem[] = [];
  const escalated: DeferredItem[] = [];
  const actionable: DeferredItem[] = [];

  for (const item of unresolved) {
    const ageDays = getItemAgeDays(item);

    // Check if referenced files were deleted
    const hasReferences = checkItemReferences(item, radlDir);
    if (!hasReferences) {
      autoResolved.push(item);
      continue;
    }

    // Escalate items older than 5 days
    if (ageDays >= 5) {
      escalated.push(item);
    }

    // Surface small-effort actionable items
    if (item.effort === 'small') {
      actionable.push(item);
    }
  }

  // Auto-resolve items if enabled
  if (autoResolve && autoResolved.length > 0) {
    const resolvedIds = new Set(autoResolved.map(i => i.id));
    const updatedStore: DeferredStore = {
      items: store.items.map(item =>
        resolvedIds.has(item.id) ? { ...item, resolved: true } : item,
      ),
    };
    saveDeferred(knowledgeDir, updatedStore);
    logger.info('Auto-resolved deferred items', { count: autoResolved.length });
  }

  return {
    total,
    unresolved: unresolved.length,
    autoResolved,
    escalated,
    actionable,
    alreadyResolved,
  };
}

/**
 * Format triage results for display.
 */
export function formatTriageOutput(result: TriageResult): string {
  const lines: string[] = ['## Deferred Item Triage', ''];

  lines.push(`**Total:** ${result.total} items (${result.alreadyResolved} previously resolved, ${result.unresolved} open)`);
  lines.push('');

  if (result.autoResolved.length > 0) {
    lines.push(`### Auto-Resolved (${result.autoResolved.length})`);
    lines.push('_Referenced files no longer exist in codebase_');
    for (const item of result.autoResolved) {
      lines.push(`- #${item.id} "${item.title}" (${item.sprintPhase})`);
    }
    lines.push('');
  }

  if (result.escalated.length > 0) {
    lines.push(`### Escalated — 5+ Days Old (${result.escalated.length})`);
    for (const item of result.escalated) {
      const age = getItemAgeDays(item);
      lines.push(`- #${item.id} "${item.title}" — ${age} days old [${item.effort}] (${item.sprintPhase})`);
    }
    lines.push('');
  }

  if (result.actionable.length > 0) {
    lines.push(`### Actionable — Small Effort (${result.actionable.length})`);
    for (const item of result.actionable) {
      lines.push(`- #${item.id} "${item.title}" — ${item.reason.substring(0, 80)} (${item.sprintPhase})`);
    }
    lines.push('');
  }

  if (result.autoResolved.length === 0 && result.escalated.length === 0 && result.actionable.length === 0) {
    lines.push('No items require attention. All deferred items are on track.');
  }

  return lines.join('\n');
}

// ============================================
// MCP Registration
// ============================================

export function registerDeferredLifecycleTools(server: McpServer): void {
  const config = getConfig();

  server.tool(
    'deferred_triage',
    'Triage deferred items: auto-close items where referenced files were deleted, escalate items older than 5 days, surface small-effort actionable items.',
    {
      auto_resolve: z.boolean().default(true)
        .describe('Auto-resolve items where referenced files no longer exist (default: true)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    withErrorTracking('deferred_triage', async ({ auto_resolve }) => {
      logger.info('Running deferred item triage', { autoResolve: auto_resolve });

      const result = runDeferredTriage(config.knowledgeDir, config.radlDir, auto_resolve);
      const output = formatTriageOutput(result);

      logger.info('Deferred triage complete', {
        total: result.total,
        autoResolved: result.autoResolved.length,
        escalated: result.escalated.length,
        actionable: result.actionable.length,
      });

      return {
        content: [{ type: 'text' as const, text: output }],
      };
    }),
  );
}
