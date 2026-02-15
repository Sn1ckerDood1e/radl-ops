/**
 * Shared Decomposition Module
 *
 * Types, schemas, constants, and helpers used by both
 * sprint-conductor.ts and sprint-decompose.ts.
 *
 * Extracted to eliminate ~150 lines of duplication.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { logger } from '../../../config/logger.js';

// ============================================
// Types
// ============================================

export interface DecomposedTask {
  id: number;
  title: string;
  description: string;
  activeForm: string;
  type: 'feature' | 'fix' | 'refactor' | 'test' | 'docs' | 'migration';
  files: string[];
  dependsOn: number[];
  estimateMinutes: number;
}

export interface Decomposition {
  tasks: DecomposedTask[];
  executionStrategy: 'sequential' | 'parallel' | 'mixed';
  rationale: string;
  totalEstimateMinutes: number;
  teamRecommendation: string;
}

// ============================================
// Constants
// ============================================

export const DECOMPOSE_RESULT_TOOL: Anthropic.Tool = {
  name: 'task_decomposition',
  description: 'Submit the structured sprint task decomposition',
  input_schema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Sequential task ID starting from 1' },
            title: { type: 'string', description: 'Imperative task title' },
            description: { type: 'string', description: 'Detailed description with acceptance criteria' },
            activeForm: { type: 'string', description: 'Present continuous form' },
            type: { type: 'string', enum: ['feature', 'fix', 'refactor', 'test', 'docs', 'migration'] },
            files: { type: 'array', items: { type: 'string' }, description: 'Files this task will modify' },
            dependsOn: { type: 'array', items: { type: 'number' }, description: 'Task IDs that must complete first' },
            estimateMinutes: { type: 'number', description: 'Estimated minutes to complete' },
          },
          required: ['id', 'title', 'description', 'activeForm', 'type', 'files', 'dependsOn', 'estimateMinutes'],
        },
      },
      executionStrategy: {
        type: 'string',
        enum: ['sequential', 'parallel', 'mixed'],
      },
      rationale: {
        type: 'string',
        description: 'Brief explanation of the decomposition approach',
      },
      totalEstimateMinutes: {
        type: 'number',
        description: 'Total wall-clock estimate (accounting for parallelism)',
      },
      teamRecommendation: {
        type: 'string',
        description: 'Whether to use an agent team and which recipe',
      },
    },
    required: ['tasks', 'executionStrategy', 'rationale', 'totalEstimateMinutes', 'teamRecommendation'],
  },
};

export const DecompositionSchema = z.object({
  tasks: z.array(z.object({
    id: z.number(),
    title: z.string(),
    description: z.string(),
    activeForm: z.string(),
    type: z.enum(['feature', 'fix', 'refactor', 'test', 'docs', 'migration']),
    files: z.array(z.string()),
    dependsOn: z.array(z.number()),
    estimateMinutes: z.number(),
  })),
  executionStrategy: z.enum(['sequential', 'parallel', 'mixed']),
  rationale: z.string(),
  totalEstimateMinutes: z.number(),
  teamRecommendation: z.string(),
});

export const DECOMPOSE_SYSTEM_PROMPT = `You are a sprint planning expert for a Next.js rowing team management SaaS (Radl).

Given a feature spec, decompose it into 3-7 concrete tasks. Each task should:
- Be completable in 15-60 minutes
- Have clear file ownership (no two tasks modify the same file)
- Include a dependency graph (which tasks must complete before others)
- Follow conventional commit types (feat, fix, refactor, test, docs, migration)

The codebase uses:
- Next.js 15 App Router with Server/Client components
- Prisma ORM with PostgreSQL (Supabase)
- Supabase Auth with getUser() (never getSession)
- Zod validation at API boundaries
- CSRF headers on authenticated API calls
- Toast notifications (sonner) for user feedback
- CSS variables for theming
- Team-scoped queries (always filter by teamId)

Task decomposition rules:
1. Schema changes (Prisma migration) must be task 1 if needed
2. API routes before UI components that call them
3. Tests after implementation (or use TDD if flagged)
4. Never put more than 3-4 files in a single task
5. If 3+ tasks are independent, recommend parallel execution with agent team
6. Trace BOTH read and write data flows for every new field

Use the task_decomposition tool to submit your structured result.`;

// ============================================
// Helpers
// ============================================

export function sanitizeForPrompt(input: string): string {
  return input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, "'")
    .replace(/\n/g, ' ')
    .trim();
}

export function parseDecomposition(response: Anthropic.Message): Decomposition | null {
  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
  );
  if (!toolBlock) return null;

  try {
    return DecompositionSchema.parse(toolBlock.input);
  } catch (error) {
    logger.warn('Invalid decomposition structure', { error: String(error) });
    return null;
  }
}
