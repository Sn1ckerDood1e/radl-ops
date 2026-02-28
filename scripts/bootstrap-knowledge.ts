#!/usr/bin/env npx tsx
/**
 * Bootstrap knowledge databases:
 * 1. FTS5 index from knowledge/*.json files
 * 2. Episodic memory seeded from patterns + lessons
 *
 * Safe to re-run — FTS rebuilds idempotently, episodes check for duplicates.
 * Usage: npx tsx scripts/bootstrap-knowledge.ts
 */

import { initFtsIndex, searchFts } from '../src/knowledge/fts-index.js';
import { recordEpisode, recallEpisodes } from '../src/knowledge/episodic.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../src/config/paths.js';

// ============================================
// 1. Bootstrap FTS5 Index
// ============================================

console.log('=== Bootstrapping FTS5 Index ===');
try {
  initFtsIndex();
  // Verify it works
  const results = searchFts({ query: 'team scoped query', maxResults: 3 });
  console.log(`FTS5 index ready. Test search returned ${results.length} results.`);
  if (results.length > 0) {
    console.log(`  Top hit: [${results[0].source}] ${results[0].text.substring(0, 80)}...`);
  }
} catch (error) {
  console.error('FTS5 init failed:', error);
}

// ============================================
// 2. Seed Episodic Memory
// ============================================

console.log('\n=== Seeding Episodic Memory ===');

// Check if episodes already exist
try {
  const existing = recallEpisodes('test', 1);
  if (existing.length > 0) {
    console.log(`Episodic DB already has data (${existing.length}+ episodes). Skipping seed.`);
    process.exit(0);
  }
} catch {
  // DB doesn't exist yet, will be created by recordEpisode
}

// Key lessons from the project history — these are the most actionable
// decisions/outcomes that future sprint planning should know about.
const seedEpisodes: Array<{
  phase: string;
  action: string;
  outcome: string;
  lesson?: string;
  tags?: string[];
}> = [
  {
    phase: 'Phase 59',
    action: 'Used listUsers() admin API for single email lookup',
    outcome: 'Loaded all users into memory — O(n) instead of O(1). Security reviewer caught it.',
    lesson: 'Always use indexed DB query (prisma.$queryRaw on auth.users) for single-user lookups.',
    tags: ['data-access', 'performance', 'antibody'],
  },
  {
    phase: 'Phase 60',
    action: 'Skipped security reviewer, only ran code reviewer before PR',
    outcome: 'Missed that tier check could receive legacy enum values. Bug shipped to main.',
    lesson: 'Always run BOTH code-reviewer AND security-reviewer before PR, especially for auth changes.',
    tags: ['review', 'security', 'workflow'],
  },
  {
    phase: 'Phase 60',
    action: 'Serialized 4 independent tasks instead of parallelizing',
    outcome: 'Added ~15 min of wall time. Tasks had no file dependencies.',
    lesson: 'When plan identifies independent tasks, spawn parallel agents. 3+ independent tasks = team.',
    tags: ['parallelization', 'agent-teams', 'efficiency'],
  },
  {
    phase: 'Phase 60',
    action: 'Server page maps props explicitly but new field not added to mapping',
    outcome: 'New field silently dropped between server and client. No error, just missing data.',
    lesson: 'When server component maps props (e.g., .map(e => ({...}))), new fields must be added to the mapping.',
    tags: ['data-flow', 'next-js', 'silent-failure'],
  },
  {
    phase: 'Phase 62',
    action: 'Used new PostgreSQL enum values in same migration that creates them',
    outcome: 'Migration failed — PostgreSQL cannot use new enum values in same transaction.',
    lesson: 'ALWAYS split into 2 migrations: first adds enum values, second uses them.',
    tags: ['postgresql', 'migration', 'enum'],
  },
  {
    phase: 'Phase 66',
    action: 'Estimated sprint at 3-4 hours based on task count',
    outcome: 'Completed in 1.5 hours. Consistent pattern: actual ~50% of estimate.',
    lesson: 'Halve the initial estimate. Sprint estimates consistently run 50% of predicted.',
    tags: ['estimation', 'calibration', 'planning'],
  },
  {
    phase: 'Phase 69',
    action: 'Added setupChecklistDismissed field to schema + validation + client',
    outcome: 'API handler never destructured the field. PATCH returned success but silently discarded it.',
    lesson: 'Trace WRITE path: Client → Validation → API handler destructure → condition check → updateData → Prisma.',
    tags: ['data-flow', 'api', 'write-path', 'antibody'],
  },
  {
    phase: 'Phase 69',
    action: 'Used lightweight parallel (Task + run_in_background) for 4 wave agents',
    outcome: '10 tasks completed in ~45 min, zero merge conflicts with strict file ownership.',
    lesson: 'Lightweight parallel > full TeamCreate for implementation. Reserve TeamCreate for reviews.',
    tags: ['parallelization', 'agent-teams', 'implementation'],
  },
  {
    phase: 'Phase 69',
    action: 'Plan listed files per agent but missed API route handler in data flow',
    outcome: 'Field added in schema (agent A) but API handler (owned by nobody) never updated.',
    lesson: 'Plans must list ALL files in every data flow. If field is written by client, API handler MUST be assigned.',
    tags: ['planning', 'data-flow', 'file-ownership'],
  },
  {
    phase: 'Phase 72',
    action: 'Used vi.resetAllMocks() in afterEach for test cleanup',
    outcome: 'Destroyed factory-level mock implementations. Tests failed intermittently.',
    lesson: 'Use vi.clearAllMocks() in beforeEach instead. resetAllMocks destroys factory mocks.',
    tags: ['testing', 'vitest', 'mocking'],
  },
  {
    phase: 'Phase 80',
    action: 'Built sprint conductor with knowledge → spec → decompose → execute pipeline',
    outcome: 'Full sprint orchestration with step-level checkpointing and plan traceability.',
    lesson: 'Structured outputs via tool_choice for reliable JSON parsing. Checkpoints enable resume after context loss.',
    tags: ['architecture', 'sprint-conductor', 'checkpointing'],
  },
  {
    phase: 'Phase 94',
    action: 'Chose dark-mode-first design system with CSS variables',
    outcome: 'Clean theme switching, no hardcoded colors. CSS variables (--surface-1, --border-subtle) used everywhere.',
    lesson: 'CSS variables for theming > Tailwind dark: classes. Design tokens in globals.css.',
    tags: ['design', 'dark-mode', 'css-variables'],
  },
  {
    phase: 'Phase 104',
    action: 'Swept 40+ files for hardcoded teal-* color references',
    outcome: 'Replaced with CSS variable references. 91.8% migrated to design tokens.',
    lesson: 'Color sweep needs parallel agents — each agent handles one file group to avoid conflicts.',
    tags: ['design', 'refactor', 'color-system'],
  },
  {
    phase: 'Phase 113',
    action: 'Wrote enforcement logic (iron laws, crystallized checks) but forgot to wire into execution path',
    outcome: 'Code existed but was never called. Zero enforcement despite full implementation.',
    lesson: 'After writing enforcement/validation, verify it is CALLED from an execution path. Dead code = zero value.',
    tags: ['wiring', 'enforcement', 'crystallized-check'],
  },
  {
    phase: 'Phase 125',
    action: 'Built GitHub issue watcher with tmux daemon and 2-hour timeout',
    outcome: 'Autonomous issue execution with auto-merge, serial safety, budget caps.',
    lesson: 'Serial execution only for autonomous agents. Always include timeout + budget cap.',
    tags: ['watcher', 'automation', 'safety'],
  },
];

let seeded = 0;
for (const ep of seedEpisodes) {
  try {
    recordEpisode(ep.phase, ep.action, ep.outcome, ep.lesson, ep.tags);
    seeded++;
  } catch (error) {
    console.error(`Failed to seed episode from ${ep.phase}:`, error);
  }
}

console.log(`Seeded ${seeded}/${seedEpisodes.length} episodes.`);

// Verify search works
try {
  const testResults = recallEpisodes('data flow API handler', 3);
  console.log(`Episodic search test: ${testResults.length} results for "data flow API handler".`);
  if (testResults.length > 0) {
    console.log(`  Top hit: [${testResults[0].sprintPhase}] ${testResults[0].action.substring(0, 80)}`);
  }
} catch (error) {
  console.error('Episodic search failed:', error);
}

console.log('\n=== Bootstrap Complete ===');
