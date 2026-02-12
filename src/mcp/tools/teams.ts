/**
 * MCP Team Recipe Tool
 *
 * Returns structured agent team recipes for Claude Code to execute.
 * radl-ops cannot call TeamCreate/SendMessage directly (MCP subprocess),
 * so it returns advisory JSON that Claude Code acts on.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { TeamRecipe } from '../../types/index.js';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';

export type RecipeType = 'review' | 'feature' | 'debug' | 'research' | 'incremental-review' | 'migration' | 'test-coverage' | 'refactor';
export type ModelTier = 'haiku' | 'sonnet' | 'opus';

interface RecipeParams {
  recipe: RecipeType;
  context?: string;
  files?: string;
  model?: ModelTier;
}

export function buildReviewRecipe(context: string, files: string, model: ModelTier): TeamRecipe {
  const fileNote = files ? ` Focus on: ${files}.` : '';
  return {
    teamName: 'review-team',
    teammates: [
      {
        name: 'security-reviewer',
        subagentType: 'security-reviewer',
        model,
        taskDescription: `Security review: OWASP Top 10, secrets, injection, auth vulnerabilities.${fileNote} ${context}`,
      },
      {
        name: 'code-reviewer',
        subagentType: 'code-reviewer',
        model,
        taskDescription: `Code quality review: dead code, types, naming, test gaps, patterns.${fileNote} ${context}`,
      },
      {
        name: 'architect',
        subagentType: 'architect',
        model,
        taskDescription: `Architecture review: module organization, coupling, extensibility, scalability.${fileNote} ${context}`,
      },
    ],
    setupSteps: [
      'Run `npm run typecheck` in the target repo to establish baseline before spawning reviewers',
      'Create team with TeamCreate',
      'Create one task per reviewer in the team task list',
      'Spawn each teammate with Task tool using run_in_background: true',
      'Work on other tasks while reviewers analyze (~5-8 min)',
      'Read findings from team messages as they arrive',
      'Fix CRITICAL and HIGH issues immediately',
    ],
    cleanupSteps: [
      'Send shutdown_request to each teammate via SendMessage',
      'Wait for shutdown confirmations',
      'Call TeamDelete to clean up team resources',
    ],
    tips: [
      'Sonnet is sufficient for all review tasks — no need for Opus',
      'Each reviewer takes 3-5 min for ~20 files',
      'Fix known issues while waiting for reviewers to finish',
      'Findings format: CRITICAL / HIGH / MEDIUM / LOW with file:line references',
    ],
  };
}

function buildFeatureRecipe(context: string, files: string, model: ModelTier): TeamRecipe {
  const fileList = files ? files.split(',').map(f => f.trim()) : [];
  const backendFiles = fileList.filter(f => f.includes('api') || f.includes('lib') || f.includes('prisma'));
  const frontendFiles = fileList.filter(f => f.includes('components') || f.includes('app/'));
  const testFiles = fileList.filter(f => f.includes('test') || f.includes('__tests__'));

  return {
    teamName: 'feature-team',
    teammates: [
      {
        name: 'backend-engineer',
        subagentType: 'general-purpose',
        model,
        taskDescription: `Backend implementation: API routes, database queries, validation schemas. ${context}`,
        fileOwnership: backendFiles.length > 0 ? backendFiles : undefined,
      },
      {
        name: 'frontend-engineer',
        subagentType: 'general-purpose',
        model,
        taskDescription: `Frontend implementation: React components, client-side state, UI/UX. ${context}`,
        fileOwnership: frontendFiles.length > 0 ? frontendFiles : undefined,
      },
      {
        name: 'test-engineer',
        subagentType: 'general-purpose',
        model,
        taskDescription: `Test implementation: unit tests, integration tests, E2E tests for the feature. ${context}`,
        fileOwnership: testFiles.length > 0 ? testFiles : undefined,
      },
    ],
    setupSteps: [
      'Create team with TeamCreate',
      'Create tasks with clear file ownership boundaries to avoid conflicts',
      'Spawn teammates with Task tool, mode: "plan" to require plan approval',
      'Review and approve each teammate\'s plan before they implement',
      'Each teammate MUST run `npm run typecheck` after their changes and before marking their task complete',
      'Monitor progress via team messages',
      'Coordinate integration points between backend and frontend',
    ],
    cleanupSteps: [
      'Send shutdown_request to each teammate via SendMessage',
      'Wait for shutdown confirmations',
      'Run `npm run typecheck && npm run test` to verify all teammates\' changes integrate without errors',
      'Call TeamDelete to clean up team resources',
    ],
    tips: [
      'Require plan approval (mode: "plan") to avoid wasted work',
      'Split file ownership clearly — each teammate owns different files',
      'Backend should finish first so frontend can integrate',
      'Test engineer can start writing test stubs while others implement',
      'Typecheck catches 80% of integration issues between teammates — enforce it per-task, not just at the end',
    ],
  };
}

function buildDebugRecipe(context: string, files: string, model: ModelTier): TeamRecipe {
  const fileNote = files ? ` Investigate in: ${files}.` : '';
  return {
    teamName: 'debug-team',
    teammates: [
      {
        name: 'data-investigator',
        subagentType: 'general-purpose',
        model,
        taskDescription: `Investigate if this is a data/state issue: check data flow, state mutations, stale data.${fileNote} Bug: ${context}`,
      },
      {
        name: 'timing-investigator',
        subagentType: 'general-purpose',
        model,
        taskDescription: `Investigate if this is a timing/race condition: check async operations, event ordering, lifecycle hooks.${fileNote} Bug: ${context}`,
      },
      {
        name: 'api-investigator',
        subagentType: 'general-purpose',
        model,
        taskDescription: `Investigate if this is an API/network issue: check request/response payloads, error handling, auth flow.${fileNote} Bug: ${context}`,
      },
    ],
    setupSteps: [
      'Create team with TeamCreate',
      'Create one task per investigator with their hypothesis',
      'Spawn teammates with Task tool using run_in_background: true',
      'Each investigator focuses on their hypothesis',
      'Investigators can message each other to share findings and disprove theories',
      'Synthesize findings to identify root cause',
    ],
    cleanupSteps: [
      'Send shutdown_request to each teammate via SendMessage',
      'Wait for shutdown confirmations',
      'Call TeamDelete to clean up team resources',
    ],
    tips: [
      'Give each investigator a different hypothesis to avoid duplicate work',
      'Encourage investigators to share evidence with each other',
      'The bug is usually in the hypothesis you least expect',
      'Check git blame for recent changes in the affected area',
    ],
  };
}

function buildResearchRecipe(context: string, files: string, model: ModelTier): TeamRecipe {
  const fileNote = files ? ` Relevant codebase areas: ${files}.` : '';
  return {
    teamName: 'research-team',
    teammates: [
      {
        name: 'library-researcher',
        subagentType: 'Explore',
        model,
        taskDescription: `Research existing packages and tools for: ${context}.${fileNote} Evaluate maturity, maintenance, bundle size, and community.`,
      },
      {
        name: 'architecture-analyst',
        subagentType: 'Plan',
        model,
        taskDescription: `Design system integration approach for: ${context}.${fileNote} Consider existing patterns, data flow, and component boundaries.`,
      },
      {
        name: 'risk-assessor',
        subagentType: 'Explore',
        model,
        taskDescription: `Identify pitfalls and risks for: ${context}.${fileNote} Check performance concerns, security issues, migration complexity, and vendor lock-in.`,
      },
    ],
    setupSteps: [
      'Create team with TeamCreate',
      'Create one task per researcher',
      'Spawn teammates with Task tool using run_in_background: true',
      'Researchers work in parallel (~3-5 min)',
      'Collect findings and synthesize recommendation',
    ],
    cleanupSteps: [
      'Send shutdown_request to each teammate via SendMessage',
      'Wait for shutdown confirmations',
      'Call TeamDelete to clean up team resources',
    ],
    tips: [
      'Library researcher and risk assessor use read-only agent types (Explore/Plan)',
      'Research teams are low-risk — no file modifications',
      'Combine findings into a decision record for compound learning',
      'Use context7 MCP tool for up-to-date library documentation',
    ],
  };
}

function buildIncrementalReviewRecipe(context: string, files: string, model: ModelTier): TeamRecipe {
  const fileNote = files ? ` Focus on: ${files}.` : '';
  return {
    teamName: 'incremental-review',
    teammates: [
      {
        name: 'pattern-reviewer',
        subagentType: 'code-reviewer',
        model,
        taskDescription: `Review recently introduced patterns for correctness and consistency. Check for: repeated anti-patterns, missed abstractions, API misuse (e.g., loading all records when querying one).${fileNote} ${context}`,
      },
      {
        name: 'security-spot-check',
        subagentType: 'security-reviewer',
        model,
        taskDescription: `Quick security spot-check on new code. Focus on: auth bypass, data leaks, injection, missing guards (e.g., last-entity deletion).${fileNote} ${context}`,
      },
    ],
    setupSteps: [
      'Spawn both reviewers with Task tool using run_in_background: true',
      'Continue working on the next task while reviewers run (~2-3 min)',
      'Read findings when they arrive',
      'Fix HIGH issues before they propagate to subsequent tasks',
    ],
    cleanupSteps: [
      'No team cleanup needed — uses background sub-agents, not agent teams',
    ],
    tips: [
      'Use after tasks that introduce NEW patterns (new API helpers, new data access patterns)',
      'Skip for tasks that follow existing patterns (copy-paste with minor changes)',
      'Haiku is sufficient for spot-checks — use Sonnet only for complex new patterns',
      'Catching bugs between tasks prevents them from propagating to later tasks',
      'This is lighter than a full review team — just 2 focused sub-agents',
      'Include \'verify npm run typecheck passes\' in the review prompt to catch type regressions early',
    ],
  };
}

function buildMigrationRecipe(context: string, files: string, model: ModelTier): TeamRecipe {
  const fileNote = files ? ` Focus on: ${files}.` : '';
  return {
    teamName: 'migration-team',
    teammates: [
      {
        name: 'database-engineer',
        subagentType: 'general-purpose',
        model,
        taskDescription: `Write migration SQL: schema changes, enum additions, rollback script. Always split enum migrations into 2 steps (add values → use values).${fileNote} ${context}`,
      },
      {
        name: 'integration-tester',
        subagentType: 'general-purpose',
        model,
        taskDescription: `Verify migration: test affected queries, validate API routes still work, check data integrity after migration.${fileNote} ${context}`,
      },
      {
        name: 'doc-updater',
        subagentType: 'general-purpose',
        model,
        taskDescription: `Update schema documentation, migration notes, and any affected API docs. Document rollback procedure.${fileNote} ${context}`,
      },
    ],
    setupSteps: [
      'Create team with TeamCreate',
      'Database engineer writes migration first (others depend on schema)',
      'Integration tester starts after migration is applied to dev',
      'Doc updater can start in parallel with integration testing',
      'Run `npx prisma migrate dev` to apply and verify migration',
    ],
    cleanupSteps: [
      'Send shutdown_request to each teammate via SendMessage',
      'Wait for shutdown confirmations',
      'Run `npx prisma migrate dev` to verify final state',
      'Call TeamDelete to clean up team resources',
    ],
    tips: [
      'ALWAYS split PostgreSQL enum additions into 2 migrations (add values → use values in same transaction fails)',
      'Include backfill UPDATE in same migration when making FK nullable',
      'Write rollback script alongside forward migration',
      'Test with realistic data volume — small test datasets miss performance issues',
    ],
  };
}

function buildTestCoverageRecipe(context: string, files: string, model: ModelTier): TeamRecipe {
  const fileNote = files ? ` Focus on: ${files}.` : '';
  return {
    teamName: 'test-coverage-team',
    teammates: [
      {
        name: 'unit-tester',
        subagentType: 'general-purpose',
        model,
        taskDescription: `Write unit tests for functions and components. Target 80%+ coverage. Use vitest, mock external dependencies.${fileNote} ${context}`,
      },
      {
        name: 'integration-tester',
        subagentType: 'general-purpose',
        model,
        taskDescription: `Write integration tests for API routes. Cover auth, validation, error paths, and happy paths.${fileNote} ${context}`,
      },
      {
        name: 'e2e-tester',
        subagentType: 'general-purpose',
        model,
        taskDescription: `Write Playwright E2E specs for critical user flows. Cover login, core CRUD, and error scenarios.${fileNote} ${context}`,
      },
    ],
    setupSteps: [
      'Create team with TeamCreate',
      'Create one task per tester with specific file/module assignments',
      'All three testers can work in parallel — they write different test types',
      'Spawn teammates with Task tool using run_in_background: true',
      'Run `npm run test` after each tester completes to verify no conflicts',
    ],
    cleanupSteps: [
      'Send shutdown_request to each teammate via SendMessage',
      'Wait for shutdown confirmations',
      'Run `npm run test` to verify all tests pass together',
      'Call TeamDelete to clean up team resources',
    ],
    tips: [
      'All three testers can work in parallel — they write different test files',
      'Mock external services (Supabase, Stripe) consistently across all test types',
      'Unit tester: focus on business logic, not framework wiring',
      'Integration tester: always test both auth success and auth failure paths',
    ],
  };
}

function buildRefactorRecipe(context: string, files: string, model: ModelTier): TeamRecipe {
  const fileNote = files ? ` Focus on: ${files}.` : '';
  return {
    teamName: 'refactor-team',
    teammates: [
      {
        name: 'dead-code-finder',
        subagentType: 'code-reviewer',
        model,
        taskDescription: `Find unused exports, dead code paths, unreachable branches, and orphaned files. List each with file:line reference.${fileNote} ${context}`,
      },
      {
        name: 'pattern-enforcer',
        subagentType: 'code-reviewer',
        model,
        taskDescription: `Identify inconsistent patterns, duplicated logic, and missing abstractions. Suggest consolidation opportunities.${fileNote} ${context}`,
      },
      {
        name: 'type-improver',
        subagentType: 'code-reviewer',
        model,
        taskDescription: `Find weak types (any, unknown without narrowing), missing return types, and opportunities for stricter type safety.${fileNote} ${context}`,
      },
    ],
    setupSteps: [
      'Create team with TeamCreate',
      'Create one task per reviewer with their analysis focus',
      'Spawn all three with Task tool using run_in_background: true',
      'Reviewers are read-only — they identify issues, you fix them',
      'Collect findings and prioritize by impact',
    ],
    cleanupSteps: [
      'Send shutdown_request to each teammate via SendMessage',
      'Wait for shutdown confirmations',
      'Call TeamDelete to clean up team resources',
    ],
    tips: [
      'Reviewers are read-only (code-reviewer agent type) — they identify, you fix',
      'Prioritize findings by impact: dead code removal > pattern consistency > type improvements',
      'Run `npm run typecheck` after each batch of fixes to catch regressions',
      'Focus on the highest-value refactors that reduce maintenance burden',
    ],
  };
}

const RECIPE_BUILDERS: Record<RecipeType, (context: string, files: string, model: ModelTier) => TeamRecipe> = {
  review: buildReviewRecipe,
  feature: buildFeatureRecipe,
  debug: buildDebugRecipe,
  research: buildResearchRecipe,
  'incremental-review': buildIncrementalReviewRecipe,
  migration: buildMigrationRecipe,
  'test-coverage': buildTestCoverageRecipe,
  refactor: buildRefactorRecipe,
};

export function formatRecipeOutput(recipe: TeamRecipe, recipeType: string): string {
  const lines: string[] = [
    `# Team Recipe: ${recipeType}`,
    '',
    `**Team Name:** \`${recipe.teamName}\``,
    '',
    '## Teammates',
    '',
  ];

  for (const t of recipe.teammates) {
    lines.push(`### ${t.name}`);
    lines.push(`- **Agent type:** \`${t.subagentType}\``);
    lines.push(`- **Model:** ${t.model}`);
    lines.push(`- **Task:** ${t.taskDescription}`);
    if (t.fileOwnership && t.fileOwnership.length > 0) {
      lines.push(`- **File ownership:** ${t.fileOwnership.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('## Setup Steps');
  lines.push('');
  for (const [i, step] of recipe.setupSteps.entries()) {
    lines.push(`${i + 1}. ${step}`);
  }

  lines.push('');
  lines.push('## Cleanup Steps');
  lines.push('');
  for (const [i, step] of recipe.cleanupSteps.entries()) {
    lines.push(`${i + 1}. ${step}`);
  }

  lines.push('');
  lines.push('## Tips');
  lines.push('');
  for (const tip of recipe.tips) {
    lines.push(`- ${tip}`);
  }

  lines.push('');
  lines.push('## Recipe Data (JSON)');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(recipe, null, 2));
  lines.push('```');

  return lines.join('\n');
}

export function registerTeamTools(server: McpServer): void {
  server.tool(
    'team_recipe',
    'Get a structured agent team recipe for Claude Code to execute. Returns teammate configuration, setup steps, and cleanup instructions. Recipes: review (3 parallel reviewers), feature (backend + frontend + tester), debug (3 hypothesis investigators), research (library + architecture + risk), incremental-review (2 background sub-agents), migration (DB engineer + tester + docs), test-coverage (unit + integration + e2e), refactor (dead code + patterns + types). Example: { "recipe": "review", "context": "auth module security audit", "files": "src/lib/auth,src/app/api/auth", "model": "sonnet" }',
    {
      recipe: z.enum(['review', 'feature', 'debug', 'research', 'incremental-review', 'migration', 'test-coverage', 'refactor'])
        .describe('Type of team recipe to generate'),
      context: z.string().max(2000).optional()
        .describe('What the team will work on (e.g., "review the auth module", "implement dark mode")'),
      files: z.string().max(2000).optional()
        .describe('Comma-separated list of files or directories involved'),
      model: z.enum(['haiku', 'sonnet', 'opus']).optional()
        .describe('Model for teammates (default: sonnet)'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    withErrorTracking('team_recipe', async ({ recipe, context, files, model }: RecipeParams) => {
      const selectedModel = model ?? 'sonnet';
      const contextStr = context ?? '';
      const filesStr = files ?? '';

      const builder = RECIPE_BUILDERS[recipe];
      const teamRecipe = builder(contextStr, filesStr, selectedModel);
      const output = formatRecipeOutput(teamRecipe, recipe);

      logger.info('Team recipe generated', { recipe, model: selectedModel, teammateCount: teamRecipe.teammates.length });

      return { content: [{ type: 'text' as const, text: output }] };
    })
  );
}
