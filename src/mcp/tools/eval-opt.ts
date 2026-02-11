/**
 * MCP Generic Eval-Opt Tool
 *
 * Exposes runEvalOptLoop() as a standalone MCP tool so Claude Code
 * can use multi-model generate->evaluate->refine for any content.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { TaskType } from '../../types/index.js';
import { runEvalOptLoop } from '../../patterns/evaluator-optimizer.js';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';

type ModelTier = 'haiku' | 'sonnet' | 'opus';

/**
 * Map friendly model names to TaskType values that route to each model.
 * See src/models/router.ts for the routing table.
 */
const MODEL_TO_TASK_TYPE: Record<ModelTier, TaskType> = {
  haiku: 'spot_check',        // routes to Haiku
  sonnet: 'conversation',     // routes to Sonnet
  opus: 'architecture',       // routes to Opus
};

interface EvalOptParams {
  prompt: string;
  criteria: string[];
  generator_model?: ModelTier;
  evaluator_model?: ModelTier;
  quality_threshold?: number;
  max_iterations?: number;
}

export function registerEvalOptTools(server: McpServer): void {
  server.tool(
    'eval_opt_generate',
    'Generate content using an evaluator-optimizer quality loop. A generator model produces content, an evaluator model scores it against your criteria, and the loop iterates until quality threshold is met. Returns the final output with quality metadata. Example: { "prompt": "Write a concise README for a CLI tool", "criteria": ["Clear install instructions", "Usage examples included", "Under 500 words"], "generator_model": "haiku", "quality_threshold": 8 }',
    {
      prompt: z.string().min(10).max(10000)
        .describe('The generation prompt - what content to produce'),
      criteria: z.array(z.string().max(500)).min(1).max(10)
        .describe('Evaluation criteria the output will be scored against'),
      generator_model: z.enum(['haiku', 'sonnet', 'opus']).optional()
        .describe('Model for generation (default: haiku - cheapest)'),
      evaluator_model: z.enum(['haiku', 'sonnet', 'opus']).optional()
        .describe('Model for evaluation (default: sonnet - good quality judgement)'),
      quality_threshold: z.number().min(1).max(10).optional()
        .describe('Minimum score to accept (default: 7)'),
      max_iterations: z.number().min(1).max(5).optional()
        .describe('Maximum refinement iterations (default: 3)'),
    },
    withErrorTracking('eval_opt_generate', async ({
      prompt,
      criteria,
      generator_model,
      evaluator_model,
      quality_threshold,
      max_iterations,
    }: EvalOptParams) => {
      const genModel = generator_model ?? 'haiku';
      const evalModel = evaluator_model ?? 'sonnet';
      const threshold = quality_threshold ?? 7;
      const maxIter = max_iterations ?? 3;

      logger.info('Eval-opt generate requested', {
        generatorModel: genModel,
        evaluatorModel: evalModel,
        threshold,
        maxIterations: maxIter,
        criteriaCount: criteria.length,
      });

      const result = await runEvalOptLoop(prompt, {
        generatorTaskType: MODEL_TO_TASK_TYPE[genModel],
        evaluatorTaskType: MODEL_TO_TASK_TYPE[evalModel],
        qualityThreshold: threshold,
        maxIterations: maxIter,
        evaluationCriteria: criteria,
      });

      const lines: string[] = [result.finalOutput];

      if (result.errors.length > 0) {
        lines.push('');
        lines.push('**Errors:**');
        for (const err of result.errors) {
          lines.push(`- ${err}`);
        }
      }

      lines.push('');
      lines.push('---');
      lines.push(`_Quality: ${result.finalScore}/10 | Iterations: ${result.iterations} | Converged: ${result.converged} | Cost: $${result.totalCostUsd}_`);

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    })
  );
}
