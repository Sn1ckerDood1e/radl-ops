/**
 * MCP Spec-to-Verification Tool
 *
 * Generates acceptance criteria and Playwright test skeletons from conductor specs.
 * Optional AI enhancement via Haiku for structured criteria extraction (~$0.002).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { getRoute, calculateCost } from '../../models/router.js';
import { trackUsage } from '../../models/token-tracker.js';
import { getAnthropicClient } from '../../config/anthropic.js';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { withRetry } from '../../utils/retry.js';
import {
  extractAcceptanceCriteria,
  generateTestSkeleton,
  formatCriteriaList,
  type AcceptanceCriterion,
} from './shared/acceptance-criteria.js';

// ============================================
// Types
// ============================================

export interface SpecVerifyResult {
  criteria: AcceptanceCriterion[];
  criteriaText: string;
  skeleton: {
    filePath: string;
    content: string;
    criteriaCount: number;
  };
  costUsd: number;
}

// ============================================
// AI Enhancement
// ============================================

const CRITERIA_EXTRACT_TOOL: Anthropic.Tool = {
  name: 'acceptance_criteria',
  description: 'Submit structured acceptance criteria extracted from a feature spec',
  input_schema: {
    type: 'object',
    properties: {
      criteria: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The acceptance criterion statement' },
            type: {
              type: 'string',
              enum: ['functional', 'validation', 'navigation', 'error-handling', 'permission'],
              description: 'Category of the criterion',
            },
          },
          required: ['text', 'type'],
        },
      },
    },
    required: ['criteria'],
  },
};

const CRITERIA_SYSTEM = `You are a QA engineer extracting acceptance criteria from a feature specification.

For each criterion:
- Write it as a testable statement (e.g., "should display athlete name in roster list")
- Classify it as: functional, validation, navigation, error-handling, or permission
- Be specific and testable — avoid vague criteria
- Include both happy path and edge cases
- Extract 5-15 criteria per spec

Categories:
- functional: Core features, data display, CRUD operations
- validation: Input validation, form rules, data format checks
- navigation: Page routing, redirects, URL patterns
- error-handling: Error states, fallbacks, timeouts, offline behavior
- permission: Role-based access, auth guards, restricted actions

Use the acceptance_criteria tool to submit your analysis.`;

/**
 * Extract criteria using Haiku AI.
 */
export async function extractCriteriaWithAI(spec: string): Promise<{ criteria: AcceptanceCriterion[]; costUsd: number }> {
  const route = getRoute('spot_check'); // Haiku — cheapest

  const response = await withRetry(
    () => getAnthropicClient().messages.create({
      model: route.model,
      max_tokens: route.maxTokens,
      system: CRITERIA_SYSTEM,
      messages: [{ role: 'user', content: `Extract acceptance criteria from this spec:\n\n${spec}` }],
      tools: [CRITERIA_EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'acceptance_criteria' },
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
    'spec-verify',
  );

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );

  if (!toolBlock) {
    return { criteria: [], costUsd: Math.round(cost * 1_000_000) / 1_000_000 };
  }

  const input = toolBlock.input as Record<string, unknown>;
  const rawCriteria = Array.isArray(input.criteria) ? input.criteria : [];

  const validTypes = ['functional', 'validation', 'navigation', 'error-handling', 'permission'];

  const criteria: AcceptanceCriterion[] = rawCriteria.map((c: Record<string, unknown>, i: number) => ({
    id: i + 1,
    text: String(c.text || ''),
    type: (validTypes.includes(String(c.type)) ? String(c.type) : 'functional') as AcceptanceCriterion['type'],
    source: 'ai' as const,
  }));

  return {
    criteria,
    costUsd: Math.round(cost * 1_000_000) / 1_000_000,
  };
}

/**
 * Run spec-to-verification pipeline.
 */
export async function runSpecVerify(spec: string, title: string, aiEnhance: boolean): Promise<SpecVerifyResult> {
  let criteria: AcceptanceCriterion[];
  let costUsd = 0;

  if (aiEnhance) {
    const aiResult = await extractCriteriaWithAI(spec);
    criteria = aiResult.criteria;
    costUsd = aiResult.costUsd;
  } else {
    criteria = extractAcceptanceCriteria(spec);
  }

  const criteriaText = formatCriteriaList(criteria);
  const skeleton = generateTestSkeleton(criteria, title);

  return {
    criteria,
    criteriaText,
    skeleton,
    costUsd,
  };
}

/**
 * Format spec-verify results for display.
 */
export function formatSpecVerifyOutput(result: SpecVerifyResult, title: string): string {
  const lines: string[] = [
    `## Spec-to-Verification: ${title}`,
    '',
    result.criteriaText,
    '',
    '---',
    '',
    `### Test Skeleton: \`${result.skeleton.filePath}\``,
    '',
    '```typescript',
    result.skeleton.content,
    '```',
    '',
    `_${result.skeleton.criteriaCount} test cases generated${result.costUsd > 0 ? ` | Cost: $${result.costUsd}` : ''}_`,
    '',
    '> **Sprint is not complete until all generated tests pass.**',
  ];

  return lines.join('\n');
}

// ============================================
// MCP Registration
// ============================================

export function registerSpecVerifyTools(server: McpServer): void {
  server.tool(
    'spec_to_tests',
    'Generate acceptance criteria and Playwright test skeletons from a feature spec. Optional AI enhancement via Haiku (~$0.002).',
    {
      spec: z.string()
        .describe('The feature specification text (from conductor or manual)'),
      title: z.string()
        .describe('Feature title for the test file name'),
      ai_enhance: z.boolean().default(false)
        .describe('Use Haiku AI for deeper criteria extraction (adds ~$0.002 cost)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    withErrorTracking('spec_to_tests', async ({ spec, title, ai_enhance }) => {
      logger.info('Running spec-to-verification', { title, aiEnhance: ai_enhance, specLength: spec.length });

      const result = await runSpecVerify(spec, title, ai_enhance);
      const output = formatSpecVerifyOutput(result, title);

      logger.info('Spec-to-verification complete', {
        criteriaCount: result.criteria.length,
        testCases: result.skeleton.criteriaCount,
        cost: result.costUsd,
      });

      return {
        content: [{ type: 'text' as const, text: output }],
      };
    }),
  );
}
