/**
 * MCP Review Pipeline Tool
 *
 * Pure advisory tool (no AI calls) that chains together a review team recipe,
 * an audit triage template, and an orchestration checklist.
 * Reduces the manual steps needed to run a full review cycle.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildReviewRecipe, formatRecipeOutput } from './teams.js';
import type { ModelTier } from './teams.js';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';

function buildTriageTemplate(sprintContext: string): string {
  const context = sprintContext || 'Code review findings';
  return [
    '## 2. Audit Triage Template',
    '',
    'After collecting reviewer findings, run this to categorize them:',
    '',
    '```json',
    '{',
    '  "tool": "audit_triage",',
    '  "params": {',
    `    "findings": "<paste combined findings from all reviewers>",`,
    `    "sprint_context": "${context}"`,
    '  }',
    '}',
    '```',
    '',
    'This will classify each finding into DO_NOW / DO_SOON / DEFER categories.',
  ].join('\n');
}

function buildOrchestrationChecklist(): string {
  return [
    '## 3. Orchestration Checklist',
    '',
    'Follow these steps in order:',
    '',
    '1. Run `npm run typecheck` to establish baseline before review',
    '2. Call `TeamCreate` with the team name from the recipe',
    '3. Create one `TaskCreate` per reviewer in the team task list',
    '4. Spawn each teammate with `Task` tool (`run_in_background: true`)',
    '5. Continue other work while reviewers analyze (~5-8 min)',
    '6. Read findings from team messages as they arrive',
    '7. Combine all findings into a single block',
    '8. Run `audit_triage` with the combined findings',
    '9. Fix DO_NOW items immediately',
    '10. Send `shutdown_request` to each teammate via `SendMessage`',
    '11. Call `TeamDelete` to clean up team resources',
    '12. Pass `team_used` to `sprint_complete` for performance tracking:',
    '    ```json',
    '    {',
    '      "recipe": "review",',
    '      "teammateCount": 3,',
    '      "model": "sonnet",',
    '      "duration": "<actual duration>",',
    '      "findingsCount": <total findings>,',
    '      "outcome": "success"',
    '    }',
    '    ```',
  ].join('\n');
}

export function registerReviewPipelineTools(server: McpServer): void {
  server.tool(
    'review_pipeline',
    'Get a complete review pipeline: team recipe + audit triage template + orchestration checklist. Chains team_recipe(review) → audit_triage → sprint_complete(team_used) into a single advisory output. Example: { "context": "Phase 62 security audit", "model": "sonnet" }',
    {
      context: z.string().max(2000).optional()
        .describe('What the review team will focus on'),
      files: z.string().max(2000).optional()
        .describe('Comma-separated list of files or directories to review'),
      model: z.enum(['haiku', 'sonnet', 'opus']).optional()
        .describe('Model for review teammates (default: sonnet)'),
    },
    withErrorTracking('review_pipeline', async ({ context, files, model }) => {
      const selectedModel: ModelTier = model ?? 'sonnet';
      const contextStr = context ?? '';
      const filesStr = files ?? '';

      // Section 1: Review team recipe
      const recipe = buildReviewRecipe(contextStr, filesStr, selectedModel);
      const recipeOutput = formatRecipeOutput(recipe, 'review');

      // Section 2: Audit triage template
      const triageTemplate = buildTriageTemplate(contextStr);

      // Section 3: Orchestration checklist
      const checklist = buildOrchestrationChecklist();

      const output = [
        '# Review Pipeline',
        '',
        'Complete workflow for running a parallel code review with triage.',
        '',
        '---',
        '',
        '## 1. Review Team Recipe',
        '',
        recipeOutput,
        '',
        '---',
        '',
        triageTemplate,
        '',
        '---',
        '',
        checklist,
      ].join('\n');

      logger.info('Review pipeline generated', { model: selectedModel, hasContext: !!context, hasFiles: !!files });

      return { content: [{ type: 'text' as const, text: output }] };
    })
  );
}
