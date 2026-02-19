/**
 * MCP Codebase Immune System Tool
 *
 * Maintains a library of "antibodies" — learned patterns from past bugs
 * that can be matched against new code changes. Each antibody captures
 * a trigger pattern and a check to run, enabling zero-cost pattern
 * matching before commits.
 *
 * Three tools:
 * - antibody_create: Uses Haiku AI to classify a bug into an antibody
 * - antibody_list: Zero-cost list of all antibodies
 * - antibody_disable: Deactivate an antibody (e.g., after false positives)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { getConfig } from '../../config/paths.js';
import { getRoute, calculateCost } from '../../models/router.js';
import { trackUsage } from '../../models/token-tracker.js';
import { getAnthropicClient } from '../../config/anthropic.js';
import { withRetry } from '../../utils/retry.js';

// ============================================
// Types
// ============================================

export interface Antibody {
  id: number;
  trigger: string;
  triggerKeywords: string[];
  check: string;
  checkType: 'grep' | 'manual';
  checkPattern: string | null;
  origin: { sprint: string; bug: string };
  catches: number;
  falsePositives: number;
  falsePositiveRate: number;
  active: boolean;
  createdAt: string;
  /** IDs of antibodies that form a compound pattern with this one */
  chainWith?: number[];
  /** Human-readable name for the compound chain */
  chainName?: string;
}

interface AntibodyStore {
  antibodies: Antibody[];
}

// ============================================
// Constants
// ============================================

const ANTIBODIES_FILE = 'antibodies.json';

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: 'classify_antibody',
  description: 'Classify a bug description into an antibody with trigger keywords and check pattern',
  input_schema: {
    type: 'object',
    properties: {
      trigger: {
        type: 'string',
        description: 'Human-readable description of what triggers this antibody (e.g., "Adding a new Prisma field without updating the API handler")',
      },
      triggerKeywords: {
        type: 'array',
        items: { type: 'string' },
        description: '5-8 lowercase keywords that identify this bug pattern in code diffs or descriptions (e.g., ["prisma", "field", "handler", "route", "api", "schema"])',
      },
      check: {
        type: 'string',
        description: 'What to check for to prevent this bug (e.g., "Verify the API route handler destructures and processes the new field")',
      },
      checkType: {
        type: 'string',
        enum: ['grep', 'manual'],
        description: 'Whether the check can be automated via grep or requires manual review',
      },
      checkPattern: {
        type: 'string',
        description: 'Regex pattern for grep-based checks (null for manual checks)',
        nullable: true,
      },
    },
    required: ['trigger', 'triggerKeywords', 'check', 'checkType', 'checkPattern'],
  },
};

const CLASSIFY_SYSTEM_PROMPT = `You are a bug pattern classifier for a codebase immune system. Given a bug description and optional code context, generate an antibody that can detect similar bugs in the future.

An antibody has:
- **trigger**: Human-readable description of the code change pattern that causes this class of bug
- **triggerKeywords**: 5-8 lowercase keywords that would appear in code diffs, commit messages, or task descriptions when this bug pattern might recur. Choose words that are specific enough to avoid false positives but broad enough to catch variations.
- **check**: A clear instruction for what to verify to prevent this bug
- **checkType**: "grep" if the check can be automated by searching for a pattern in code, "manual" if it requires human judgment
- **checkPattern**: If checkType is "grep", provide a regex pattern. If "manual", set to null.

Be specific and actionable. The antibody should catch the CLASS of bug, not just the exact instance.

Use the classify_antibody tool to submit your analysis.`;

// ============================================
// File I/O
// ============================================

function getAntibodiesPath(): string {
  return join(getConfig().knowledgeDir, ANTIBODIES_FILE);
}

export function loadAntibodies(): AntibodyStore {
  const filePath = getAntibodiesPath();
  if (!existsSync(filePath)) {
    return { antibodies: [] };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as AntibodyStore;
    if (!Array.isArray(parsed.antibodies)) {
      return { antibodies: [] };
    }
    return parsed;
  } catch (error) {
    logger.warn('Failed to parse antibodies.json, returning empty store', {
      error: String(error),
    });
    return { antibodies: [] };
  }
}

export function saveAntibodies(data: AntibodyStore): void {
  const filePath = getAntibodiesPath();
  const dir = getConfig().knowledgeDir;

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ============================================
// Core Logic
// ============================================

/**
 * Zero-cost keyword matching: lowercase the text, check each active
 * antibody's triggerKeywords, return antibodies where 2+ keywords match.
 */
export function matchAntibodies(text: string, antibodies: Antibody[]): Antibody[] {
  const lowerText = text.toLowerCase();

  return antibodies.filter(ab => {
    if (!ab.active) return false;

    const matchCount = ab.triggerKeywords.reduce((count, keyword) => {
      if (lowerText.includes(keyword)) {
        return count + 1;
      }
      return count;
    }, 0);

    return matchCount >= 2;
  });
}

/**
 * Detect compound antibody chains: when 2+ chain-linked antibodies fire
 * on the same text, it indicates a compound risk pattern. Returns chain
 * warnings with elevated severity.
 */
export interface ChainWarning {
  chainName: string;
  antibodyIds: number[];
  triggers: string[];
  severity: 'critical';
  message: string;
}

export function matchAntibodyChains(
  text: string,
  antibodies: Antibody[],
): ChainWarning[] {
  // First, get all individually matched antibodies
  const matched = matchAntibodies(text, antibodies);
  if (matched.length < 2) return [];

  const matchedIds = new Set(matched.map(a => a.id));
  const warnings: ChainWarning[] = [];
  const processedChains = new Set<string>();

  for (const ab of matched) {
    if (!ab.chainWith || ab.chainWith.length === 0) continue;

    // Check if any chain partners also matched
    const chainPartners = ab.chainWith.filter(id => matchedIds.has(id));
    if (chainPartners.length === 0) continue;

    // Build the full chain (this antibody + partners)
    const chainIds = [ab.id, ...chainPartners].sort();
    const chainKey = chainIds.join(',');

    // Skip if we already processed this chain
    if (processedChains.has(chainKey)) continue;
    processedChains.add(chainKey);

    const chainAntibodies = antibodies.filter(a => chainIds.includes(a.id));
    const chainName = ab.chainName ?? chainAntibodies.map(a => a.trigger).join(' + ');

    warnings.push({
      chainName,
      antibodyIds: chainIds,
      triggers: chainAntibodies.map(a => a.trigger),
      severity: 'critical',
      message: `Compound pattern detected: ${chainName}. Multiple related antibodies fired simultaneously, indicating a multi-step failure risk. Antibodies: ${chainIds.map(id => `#${id}`).join(', ')}`,
    });
  }

  return warnings;
}

/**
 * Parse the structured tool_use response from Haiku into antibody fields.
 */
function parseClassifyResponse(response: Anthropic.Message): {
  trigger: string;
  triggerKeywords: string[];
  check: string;
  checkType: 'grep' | 'manual';
  checkPattern: string | null;
} | null {
  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );

  if (!toolBlock) return null;

  const input = toolBlock.input as Record<string, unknown>;

  const trigger = String(input.trigger || '');
  const rawKeywords = Array.isArray(input.triggerKeywords) ? input.triggerKeywords : [];
  const triggerKeywords = rawKeywords
    .map((k: unknown) => String(k).toLowerCase().trim())
    .filter((k: string) => k.length > 0);
  const check = String(input.check || '');
  const rawCheckType = String(input.checkType || 'manual');
  const checkType = rawCheckType === 'grep' ? 'grep' : 'manual';
  const checkPattern = input.checkPattern != null ? String(input.checkPattern) : null;

  if (!trigger || triggerKeywords.length === 0 || !check) {
    return null;
  }

  return { trigger, triggerKeywords, check, checkType, checkPattern };
}

function sanitizeForPrompt(input: string): string {
  return input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Format antibodies as a markdown table for display.
 */
function formatAntibodyTable(antibodies: Antibody[]): string {
  if (antibodies.length === 0) {
    return '# Antibody Library\n\nNo antibodies registered yet. Use `antibody_create` to add one from a bug description.';
  }

  const lines: string[] = [
    '# Antibody Library',
    '',
    `**Total:** ${antibodies.length} | **Active:** ${antibodies.filter(a => a.active).length}`,
    '',
    '| ID | Active | Trigger | Check Type | Catches | FP Rate | Origin |',
    '|----|--------|---------|------------|---------|---------|--------|',
  ];

  for (const ab of antibodies) {
    const activeIcon = ab.active ? 'YES' : 'NO';
    const fpRate = ab.falsePositiveRate > 0
      ? `${(ab.falsePositiveRate * 100).toFixed(0)}%`
      : '0%';
    const origin = ab.origin.sprint || 'unknown';
    const triggerShort = ab.trigger.length > 50
      ? ab.trigger.substring(0, 47) + '...'
      : ab.trigger;

    lines.push(
      `| ${ab.id} | ${activeIcon} | ${triggerShort} | ${ab.checkType} | ${ab.catches} | ${fpRate} | ${origin} |`
    );
  }

  lines.push('');

  // Detail section for each antibody
  lines.push('## Details');
  lines.push('');

  for (const ab of antibodies) {
    lines.push(`### Antibody #${ab.id}${ab.active ? '' : ' (DISABLED)'}`);
    lines.push('');
    lines.push(`**Trigger:** ${ab.trigger}`);
    lines.push(`**Keywords:** ${ab.triggerKeywords.join(', ')}`);
    lines.push(`**Check:** ${ab.check}`);
    if (ab.checkType === 'grep' && ab.checkPattern) {
      lines.push(`**Pattern:** \`${ab.checkPattern}\``);
    }
    lines.push(`**Origin:** Sprint ${ab.origin.sprint} — ${ab.origin.bug}`);
    lines.push(`**Stats:** ${ab.catches} catches, ${ab.falsePositives} false positives`);
    lines.push(`**Created:** ${ab.createdAt}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================
// Exportable Core Logic (for auto-invocation)
// ============================================

/**
 * Core antibody creation logic. Calls Haiku to classify a bug description
 * into an antibody and saves it to the store. Returns the antibody id and
 * trigger, or null if classification failed.
 *
 * Used by sprint_complete for auto-creating antibodies from review findings.
 * Cost: ~$0.001 per call (Haiku).
 */
export async function createAntibodyCore(
  bugDescription: string,
  codeContext?: string,
  sprintPhase?: string,
): Promise<{ id: number; trigger: string } | null> {
  const route = getRoute('spot_check');
  const phase = sprintPhase ?? 'unknown';

  const userMessage = [
    `Bug description: ${sanitizeForPrompt(bugDescription)}`,
    codeContext ? `\nCode context:\n${sanitizeForPrompt(codeContext)}` : '',
    phase !== 'unknown' ? `\nSprint phase: ${sanitizeForPrompt(phase)}` : '',
  ].filter(Boolean).join('\n');

  const response = await withRetry(
    () => getAnthropicClient().messages.create({
      model: route.model,
      max_tokens: route.maxTokens,
      system: CLASSIFY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: 'tool', name: 'classify_antibody' },
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
    'antibody-create',
  );

  const classified = parseClassifyResponse(response);
  if (!classified) {
    return null;
  }

  const store = loadAntibodies();
  const nextId = store.antibodies.reduce((max, ab) => Math.max(max, ab.id), 0) + 1;

  const newAntibody: Antibody = {
    id: nextId,
    trigger: classified.trigger,
    triggerKeywords: classified.triggerKeywords,
    check: classified.check,
    checkType: classified.checkType,
    checkPattern: classified.checkPattern,
    origin: { sprint: phase, bug: bugDescription.substring(0, 200) },
    catches: 0,
    falsePositives: 0,
    falsePositiveRate: 0,
    active: true,
    createdAt: new Date().toISOString(),
  };

  const updatedStore: AntibodyStore = {
    antibodies: [...store.antibodies, newAntibody],
  };
  saveAntibodies(updatedStore);

  logger.info('Antibody created', {
    id: nextId,
    trigger: classified.trigger,
    checkType: classified.checkType,
    keywordCount: classified.triggerKeywords.length,
    cost,
  });

  return { id: nextId, trigger: classified.trigger };
}

// ============================================
// MCP Registration
// ============================================

export function registerImmuneSystemTools(server: McpServer): void {

  // --- antibody_create ---
  server.tool(
    'antibody_create',
    'Create a new antibody from a bug description using AI (Haiku). The antibody captures the bug pattern so it can be detected in future code changes. Cost: ~$0.001.',
    {
      bug_description: z.string().min(10).max(5000)
        .describe('Description of the bug that was found and fixed'),
      code_context: z.string().max(10000).optional()
        .describe('Optional code snippet or diff showing the bug and fix'),
      sprint_phase: z.string().max(100).optional()
        .describe('Sprint phase where the bug was found (e.g., "Phase 69")'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    withErrorTracking('antibody_create', async ({ bug_description, code_context, sprint_phase }) => {
      logger.info('Creating antibody from bug description', {
        descriptionLength: bug_description.length,
        hasCodeContext: !!code_context,
        phase: sprint_phase ?? 'unknown',
      });

      const result = await createAntibodyCore(bug_description, code_context, sprint_phase);

      if (!result) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Failed to classify the bug description into an antibody. The AI response did not include structured output. Try rephrasing the bug description.',
          }],
          isError: true,
        };
      }

      const store = loadAntibodies();
      const antibody = store.antibodies.find(ab => ab.id === result.id);

      const lines: string[] = [
        `## Antibody #${result.id} Created`,
        '',
        `**Trigger:** ${antibody?.trigger ?? result.trigger}`,
        `**Keywords:** ${antibody?.triggerKeywords.join(', ') ?? ''}`,
        `**Check:** ${antibody?.check ?? ''}`,
        `**Type:** ${antibody?.checkType ?? 'manual'}`,
      ];

      if (antibody?.checkType === 'grep' && antibody.checkPattern) {
        lines.push(`**Pattern:** \`${antibody.checkPattern}\``);
      }

      lines.push(`**Origin:** Sprint ${sprint_phase ?? 'unknown'}`);
      lines.push('');
      lines.push(`_Cost: ~$0.001 (Haiku)_`);

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }),
  );

  // --- antibody_list ---
  server.tool(
    'antibody_list',
    'List all registered antibodies in the codebase immune system. Zero cost (file read only).',
    {
      active_only: z.boolean().optional().default(false)
        .describe('If true, only show active antibodies'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    withErrorTracking('antibody_list', async ({ active_only }) => {
      const store = loadAntibodies();

      const filtered = active_only
        ? store.antibodies.filter(ab => ab.active)
        : store.antibodies;

      logger.info('Listing antibodies', {
        total: store.antibodies.length,
        filtered: filtered.length,
        activeOnly: active_only,
      });

      const output = formatAntibodyTable(filtered);

      return {
        content: [{ type: 'text' as const, text: output }],
      };
    }),
  );

  // --- antibody_disable ---
  server.tool(
    'antibody_disable',
    'Deactivate an antibody by ID (e.g., after too many false positives). The antibody remains in the store but is skipped during matching.',
    {
      id: z.number().int().min(1)
        .describe('The antibody ID to disable'),
      reason: z.string().max(500).optional()
        .describe('Optional reason for disabling (logged for audit)'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    withErrorTracking('antibody_disable', async ({ id, reason }) => {
      const store = loadAntibodies();

      const index = store.antibodies.findIndex(ab => ab.id === id);
      if (index === -1) {
        return {
          content: [{
            type: 'text' as const,
            text: `Antibody #${id} not found. Use \`antibody_list\` to see available IDs.`,
          }],
          isError: true,
        };
      }

      const antibody = store.antibodies[index];
      if (!antibody.active) {
        return {
          content: [{
            type: 'text' as const,
            text: `Antibody #${id} is already disabled.`,
          }],
        };
      }

      const updatedAntibody: Antibody = {
        ...antibody,
        active: false,
      };

      const updatedStore: AntibodyStore = {
        antibodies: store.antibodies.map(ab =>
          ab.id === id ? updatedAntibody : ab
        ),
      };
      saveAntibodies(updatedStore);

      logger.info('Antibody disabled', {
        id,
        trigger: antibody.trigger,
        reason: reason ?? 'no reason provided',
      });

      return {
        content: [{
          type: 'text' as const,
          text: `Antibody #${id} disabled.\n\n` +
            `**Trigger:** ${antibody.trigger}\n` +
            `**Reason:** ${reason ?? 'No reason provided'}\n` +
            `**Lifetime stats:** ${antibody.catches} catches, ${antibody.falsePositives} false positives`,
        }],
      };
    }),
  );
}
