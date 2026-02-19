/**
 * MCP Knowledge Crystallization Tools
 *
 * Promotes frequently-recurring lessons into automated checks.
 * Uses Haiku AI to analyze high-frequency lessons and propose
 * trigger/keyword/check combinations that can be matched at
 * zero cost against future code changes.
 *
 * Flow: lessons accumulate frequency via compound.ts ->
 *       crystallize_propose finds high-frequency ones ->
 *       Haiku groups and proposes checks ->
 *       human approves/demotes ->
 *       matchCrystallizedChecks used by hooks at zero cost
 *
 * Cost: ~$0.002 per proposal batch (Haiku).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { getConfig } from '../../config/paths.js';
import Anthropic from '@anthropic-ai/sdk';
import { getRoute, calculateCost } from '../../models/router.js';
import { trackUsage } from '../../models/token-tracker.js';
import { getAnthropicClient } from '../../config/anthropic.js';
import { withRetry } from '../../utils/retry.js';

// ============================================
// Types
// ============================================

export interface CrystallizedCheck {
  id: number;
  lessonIds: number[];
  trigger: string;
  triggerKeywords: string[];
  check: string;
  checkType: 'grep' | 'manual';
  grepPattern: string | null;
  status: 'proposed' | 'active' | 'demoted';
  proposedAt: string;
  approvedAt: string | null;
  catches: number;
  falsePositives: number;
  demotedAt: string | null;
  demotionReason: string | null;
}

interface CrystallizedFile {
  checks: CrystallizedCheck[];
}

interface LessonEntry {
  id: number;
  situation: string;
  learning: string;
  date: string;
  frequency?: number;
  lastSeenAt?: string;
}

interface LessonsFile {
  lessons: LessonEntry[];
}

interface ProposedCheck {
  lessonIds: number[];
  trigger: string;
  triggerKeywords: string[];
  check: string;
  checkType: 'grep' | 'manual';
  grepPattern: string | null;
}

// ============================================
// Structured Tool Schema for Haiku
// ============================================

const CRYSTALLIZE_TOOL: Anthropic.Tool = {
  name: 'crystallize_proposals',
  description: 'Submit structured check proposals derived from high-frequency lessons',
  input_schema: {
    type: 'object',
    properties: {
      proposals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            lessonIds: {
              type: 'array',
              items: { type: 'number' },
              description: 'IDs of the lessons this check covers',
            },
            trigger: {
              type: 'string',
              description: 'Human-readable description of when this check should fire',
            },
            triggerKeywords: {
              type: 'array',
              items: { type: 'string' },
              description: 'Lowercase keywords that, when 2+ match in text, trigger this check',
            },
            check: {
              type: 'string',
              description: 'The actionable check to perform (instruction or grep pattern)',
            },
            checkType: {
              type: 'string',
              enum: ['grep', 'manual'],
              description: 'Whether this check can be automated via grep or requires manual review',
            },
            grepPattern: {
              type: 'string',
              description: 'Regex pattern for automated grep checks (null for manual)',
              nullable: true,
            },
          },
          required: ['lessonIds', 'trigger', 'triggerKeywords', 'check', 'checkType'],
        },
      },
    },
    required: ['proposals'],
  },
};

const CRYSTALLIZE_SYSTEM = `You are a knowledge crystallization engine. You receive lessons that have been observed multiple times during software development sprints.

Your job is to group related lessons and propose automated checks that will catch the same issues in the future.

Rules:
1. Group lessons that address the same root cause or concern.
2. Each proposal should have 3-6 triggerKeywords that are lowercase, specific words likely to appear in code diffs or commit messages when the issue could recur.
3. For grep-checkable patterns (like missing fields, wrong function calls), set checkType to "grep" and provide a grepPattern regex.
4. For higher-level concerns (architectural decisions, workflow steps), set checkType to "manual" and provide a clear check instruction.
5. triggerKeywords should be specific enough to avoid false positives but broad enough to catch real issues. Aim for domain-specific terms.
6. Each proposal must reference at least one lesson ID.
7. Do NOT propose checks for one-off or context-specific lessons. Only propose checks for patterns that are likely to recur.

Use the crystallize_proposals tool to submit your analysis.`;

// ============================================
// File I/O
// ============================================

export function loadCrystallized(): CrystallizedFile {
  const knowledgeDir = getConfig().knowledgeDir;
  const filePath = join(knowledgeDir, 'crystallized.json');

  if (!existsSync(filePath)) {
    return { checks: [] };
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as CrystallizedFile;
    return {
      checks: Array.isArray(parsed.checks) ? parsed.checks : [],
    };
  } catch (error) {
    logger.warn('Failed to load crystallized.json, starting fresh', { error: String(error) });
    return { checks: [] };
  }
}

export function saveCrystallized(data: CrystallizedFile): void {
  const knowledgeDir = getConfig().knowledgeDir;
  const filePath = join(knowledgeDir, 'crystallized.json');
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadLessons(): LessonsFile {
  const knowledgeDir = getConfig().knowledgeDir;
  const lessonsPath = join(knowledgeDir, 'lessons.json');

  if (!existsSync(lessonsPath)) {
    return { lessons: [] };
  }

  try {
    const raw = readFileSync(lessonsPath, 'utf-8');
    return JSON.parse(raw) as LessonsFile;
  } catch (error) {
    logger.warn('Failed to load lessons.json', { error: String(error) });
    return { lessons: [] };
  }
}

// ============================================
// Zero-Cost Matching (same algorithm as immune system)
// ============================================

/**
 * Match crystallized checks against text using keyword overlap.
 * Returns checks where 2+ triggerKeywords appear in the text.
 * Only matches active checks. Zero API cost.
 */
export function matchCrystallizedChecks(
  text: string,
  checks: CrystallizedCheck[],
): CrystallizedCheck[] {
  const lowerText = text.toLowerCase();

  return checks.filter(check => {
    if (check.status !== 'active') return false;

    const matchCount = check.triggerKeywords.reduce(
      (count, keyword) => count + (lowerText.includes(keyword) ? 1 : 0),
      0,
    );

    return matchCount >= 2;
  });
}

// ============================================
// AI Proposal Logic
// ============================================

function parseProposalResponse(response: Anthropic.Message): ProposedCheck[] {
  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );

  if (!toolBlock) {
    return [];
  }

  const input = toolBlock.input as Record<string, unknown>;
  const rawProposals = Array.isArray(input.proposals) ? input.proposals : [];

  return rawProposals.map((p: Record<string, unknown>) => ({
    lessonIds: Array.isArray(p.lessonIds)
      ? (p.lessonIds as unknown[]).map(id => Number(id)).filter(id => !isNaN(id))
      : [],
    trigger: String(p.trigger || ''),
    triggerKeywords: Array.isArray(p.triggerKeywords)
      ? (p.triggerKeywords as unknown[]).map(k => String(k).toLowerCase())
      : [],
    check: String(p.check || ''),
    checkType: p.checkType === 'grep' ? 'grep' as const : 'manual' as const,
    grepPattern: typeof p.grepPattern === 'string' ? p.grepPattern : null,
  }));
}

async function proposeChecks(
  qualifyingLessons: LessonEntry[],
): Promise<{ proposals: ProposedCheck[]; costUsd: number }> {
  const lessonsText = qualifyingLessons.map(l =>
    `- [ID ${l.id}] (freq: ${l.frequency ?? 1}) ${l.situation}: ${l.learning}`
  ).join('\n');

  const route = getRoute('spot_check');

  const response = await withRetry(
    () => getAnthropicClient().messages.create({
      model: route.model,
      max_tokens: route.maxTokens,
      system: CRYSTALLIZE_SYSTEM,
      messages: [{
        role: 'user',
        content: `Analyze these high-frequency lessons and propose automated checks:\n\n${lessonsText}`,
      }],
      tools: [CRYSTALLIZE_TOOL],
      tool_choice: { type: 'tool', name: 'crystallize_proposals' },
    }),
    { maxRetries: 2, baseDelayMs: 1000 },
  );

  const cost = calculateCost(
    route.model,
    response.usage.input_tokens,
    response.usage.output_tokens,
  );

  trackUsage(
    route.model,
    response.usage.input_tokens,
    response.usage.output_tokens,
    'spot_check',
    'crystallize-propose',
  );

  const proposals = parseProposalResponse(response);

  return {
    proposals,
    costUsd: Math.round(cost * 1_000_000) / 1_000_000,
  };
}

// ============================================
// Formatting
// ============================================

function formatCheckForDisplay(check: CrystallizedCheck): string {
  const statusIcon = check.status === 'active'
    ? 'ACTIVE'
    : check.status === 'proposed'
      ? 'PROPOSED'
      : 'DEMOTED';

  const lines = [
    `### [${statusIcon}] Check #${check.id}`,
    `**Trigger:** ${check.trigger}`,
    `**Keywords:** ${check.triggerKeywords.join(', ')}`,
    `**Check:** ${check.check}`,
    `**Type:** ${check.checkType}${check.grepPattern ? ` (\`${check.grepPattern}\`)` : ''}`,
    `**Lessons:** ${check.lessonIds.join(', ')}`,
    `**Stats:** ${check.catches} catches, ${check.falsePositives} false positives`,
  ];

  if (check.approvedAt) {
    lines.push(`**Approved:** ${check.approvedAt}`);
  }

  if (check.demotedAt) {
    lines.push(`**Demoted:** ${check.demotedAt} — ${check.demotionReason}`);
  }

  return lines.join('\n');
}

// ============================================
// Exportable Core Logic (for auto-invocation)
// ============================================

/**
 * Propose crystallized checks from lessons that meet the frequency threshold.
 * Saves proposals to crystallized.json with status 'proposed'.
 * Returns the number of checks proposed.
 *
 * Used by sprint_complete every N sprints to auto-propose checks.
 * Cost: ~$0.002 per call (Haiku).
 */
export async function proposeChecksFromLessons(minFrequency: number = 1): Promise<number> {
  const lessonsFile = loadLessons();
  const qualifyingLessons = lessonsFile.lessons.filter(
    l => (l.frequency ?? 1) >= minFrequency,
  );

  if (qualifyingLessons.length === 0) {
    return 0;
  }

  const { proposals } = await proposeChecks(qualifyingLessons);
  if (proposals.length === 0) {
    return 0;
  }

  const crystallized = loadCrystallized();
  const nextId = crystallized.checks.reduce((max, c) => Math.max(max, c.id), 0) + 1;
  const now = new Date().toISOString();

  const newChecks: CrystallizedCheck[] = proposals.map((p, i) => ({
    id: nextId + i,
    lessonIds: p.lessonIds,
    trigger: p.trigger,
    triggerKeywords: p.triggerKeywords,
    check: p.check,
    checkType: p.checkType,
    grepPattern: p.grepPattern,
    status: 'proposed' as const,
    proposedAt: now,
    approvedAt: null,
    catches: 0,
    falsePositives: 0,
    demotedAt: null,
    demotionReason: null,
  }));

  const updatedCrystallized: CrystallizedFile = {
    checks: [...crystallized.checks, ...newChecks],
  };
  saveCrystallized(updatedCrystallized);

  logger.info('Auto-crystallization proposals saved', { count: newChecks.length });
  return newChecks.length;
}

// ============================================
// MCP Tool Registration
// ============================================

export function registerCrystallizationTools(server: McpServer): void {
  // ---- crystallize_propose ----
  server.tool(
    'crystallize_propose',
    'Use Haiku AI to find high-frequency lessons and propose automated checks. Lessons with frequency >= min_frequency are analyzed, grouped, and turned into trigger/keyword/check proposals. Cost: ~$0.002.',
    {
      min_frequency: z.number().int().min(1).optional().default(3)
        .describe('Minimum lesson frequency to qualify for crystallization (default: 3)'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    withErrorTracking('crystallize_propose', async ({ min_frequency }) => {
      const lessonsFile = loadLessons();

      const qualifyingLessons = lessonsFile.lessons.filter(
        l => (l.frequency ?? 1) >= min_frequency,
      );

      if (qualifyingLessons.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No lessons found with frequency >= ${min_frequency}. ` +
              `Total lessons: ${lessonsFile.lessons.length}. ` +
              'Lessons accumulate frequency when the same insight is extracted multiple times via compound learning.',
          }],
        };
      }

      logger.info('Crystallization proposal starting', {
        qualifyingCount: qualifyingLessons.length,
        minFrequency: min_frequency,
        totalLessons: lessonsFile.lessons.length,
      });

      const { proposals, costUsd } = await proposeChecks(qualifyingLessons);

      if (proposals.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Haiku analyzed ${qualifyingLessons.length} lessons but found no recurring patterns worth crystallizing. Cost: $${costUsd}`,
          }],
        };
      }

      // Save proposals to crystallized.json
      const crystallized = loadCrystallized();
      const nextId = crystallized.checks.reduce((max, c) => Math.max(max, c.id), 0) + 1;
      const now = new Date().toISOString();

      const newChecks: CrystallizedCheck[] = proposals.map((p, i) => ({
        id: nextId + i,
        lessonIds: p.lessonIds,
        trigger: p.trigger,
        triggerKeywords: p.triggerKeywords,
        check: p.check,
        checkType: p.checkType,
        grepPattern: p.grepPattern,
        status: 'proposed' as const,
        proposedAt: now,
        approvedAt: null,
        catches: 0,
        falsePositives: 0,
        demotedAt: null,
        demotionReason: null,
      }));

      const updatedCrystallized: CrystallizedFile = {
        checks: [...crystallized.checks, ...newChecks],
      };
      saveCrystallized(updatedCrystallized);

      // Format output
      const lines: string[] = [
        `## Crystallization Proposals`,
        '',
        `**Lessons analyzed:** ${qualifyingLessons.length} (frequency >= ${min_frequency})`,
        `**Checks proposed:** ${newChecks.length}`,
        `**Cost:** $${costUsd}`,
        '',
      ];

      for (const check of newChecks) {
        lines.push(formatCheckForDisplay(check));
        lines.push('');
      }

      lines.push('Use `crystallize_approve` to activate a check, or `crystallize_demote` to reject it.');

      logger.info('Crystallization proposals saved', {
        proposalsCount: newChecks.length,
        cost: costUsd,
      });

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }),
  );

  // ---- crystallize_approve ----
  server.tool(
    'crystallize_approve',
    'Approve a proposed crystallized check, setting its status to active. Active checks are matched against code changes at zero cost.',
    {
      id: z.number().int().describe('ID of the proposed check to approve'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    withErrorTracking('crystallize_approve', async ({ id }) => {
      const crystallized = loadCrystallized();

      const checkIndex = crystallized.checks.findIndex(c => c.id === id);
      if (checkIndex === -1) {
        return {
          content: [{
            type: 'text' as const,
            text: `Check #${id} not found. Use \`crystallize_list\` to see available checks.`,
          }],
        };
      }

      const existing = crystallized.checks[checkIndex];
      if (existing.status === 'active') {
        return {
          content: [{
            type: 'text' as const,
            text: `Check #${id} is already active.`,
          }],
        };
      }

      const updatedCheck: CrystallizedCheck = {
        ...existing,
        status: 'active',
        approvedAt: new Date().toISOString(),
      };

      const updatedChecks = crystallized.checks.map((c, i) =>
        i === checkIndex ? updatedCheck : c,
      );

      saveCrystallized({ checks: updatedChecks });

      logger.info('Crystallized check approved', { id, trigger: updatedCheck.trigger });

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Check #${id} approved and activated.`,
            '',
            formatCheckForDisplay(updatedCheck),
            '',
            'This check will now be matched against code changes at zero cost.',
          ].join('\n'),
        }],
      };
    }),
  );

  // ---- crystallize_demote ----
  server.tool(
    'crystallize_demote',
    'Demote a crystallized check with a reason. Demoted checks are no longer matched against code changes.',
    {
      id: z.number().int().describe('ID of the check to demote'),
      reason: z.string().min(1).describe('Reason for demotion (e.g., "too many false positives")'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    withErrorTracking('crystallize_demote', async ({ id, reason }) => {
      const crystallized = loadCrystallized();

      const checkIndex = crystallized.checks.findIndex(c => c.id === id);
      if (checkIndex === -1) {
        return {
          content: [{
            type: 'text' as const,
            text: `Check #${id} not found. Use \`crystallize_list\` to see available checks.`,
          }],
        };
      }

      const existing = crystallized.checks[checkIndex];
      if (existing.status === 'demoted') {
        return {
          content: [{
            type: 'text' as const,
            text: `Check #${id} is already demoted.`,
          }],
        };
      }

      const updatedCheck: CrystallizedCheck = {
        ...existing,
        status: 'demoted',
        demotedAt: new Date().toISOString(),
        demotionReason: reason,
      };

      const updatedChecks = crystallized.checks.map((c, i) =>
        i === checkIndex ? updatedCheck : c,
      );

      saveCrystallized({ checks: updatedChecks });

      logger.info('Crystallized check demoted', { id, reason });

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Check #${id} demoted.`,
            '',
            formatCheckForDisplay(updatedCheck),
          ].join('\n'),
        }],
      };
    }),
  );

  // ---- crystallize_list ----
  server.tool(
    'crystallize_list',
    'List crystallized checks, optionally filtered by status (proposed, active, demoted).',
    {
      status: z.enum(['proposed', 'active', 'demoted']).optional()
        .describe('Filter by status. Omit to show all checks.'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    withErrorTracking('crystallize_list', async ({ status }) => {
      const crystallized = loadCrystallized();

      const filtered = status
        ? crystallized.checks.filter(c => c.status === status)
        : crystallized.checks;

      if (filtered.length === 0) {
        const qualifier = status ? ` with status "${status}"` : '';
        return {
          content: [{
            type: 'text' as const,
            text: `No crystallized checks found${qualifier}. Use \`crystallize_propose\` to generate proposals from high-frequency lessons.`,
          }],
        };
      }

      const activeCount = crystallized.checks.filter(c => c.status === 'active').length;
      const proposedCount = crystallized.checks.filter(c => c.status === 'proposed').length;
      const demotedCount = crystallized.checks.filter(c => c.status === 'demoted').length;

      const lines: string[] = [
        '## Crystallized Checks',
        '',
        `**Total:** ${crystallized.checks.length} (${activeCount} active, ${proposedCount} proposed, ${demotedCount} demoted)`,
        '',
      ];

      if (status) {
        lines.push(`_Showing: ${status} only_`);
        lines.push('');
      }

      for (const check of filtered) {
        lines.push(formatCheckForDisplay(check));
        lines.push('');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }),
  );
}
