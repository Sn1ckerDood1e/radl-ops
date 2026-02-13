/**
 * MCP Sprint Tools - Sprint management via sprint.sh
 *
 * Wraps the sprint.sh shell script as MCP tools for conversational
 * sprint management within Claude Code sessions.
 *
 * Integrates iron law checks to enforce workflow constraints.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFileSync, execSync } from 'child_process';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { logger } from '../../config/logger.js';
import { checkIronLaws, getIronLaws } from '../../guardrails/iron-laws.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { setCurrentSprintPhase } from '../../models/token-tracker.js';
import type { TeamRun, TeamRunStore } from '../../types/index.js';
import { getConfig } from '../../config/paths.js';

function getDeferredPath(): string {
  return `${getConfig().knowledgeDir}/deferred.json`;
}
function getTeamRunsPath(): string {
  return `${getConfig().knowledgeDir}/team-runs.json`;
}

interface DeferredItem {
  id: number;
  title: string;
  reason: string;
  effort: 'small' | 'medium' | 'large';
  sprintPhase: string;
  date: string;
  resolved: boolean;
}

interface DeferredStore {
  items: DeferredItem[];
}

function loadDeferred(): DeferredStore {
  if (!existsSync(getDeferredPath())) return { items: [] };
  try {
    return JSON.parse(readFileSync(getDeferredPath(), 'utf-8')) as DeferredStore;
  } catch (error) {
    logger.error('Failed to load deferred items, returning empty store', {
      error: String(error),
      path: getDeferredPath(),
    });
    return { items: [] };
  }
}

function saveDeferred(store: DeferredStore): void {
  const tmpPath = `${getDeferredPath()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(store, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, getDeferredPath());
}

function loadTeamRuns(): TeamRunStore {
  if (!existsSync(getTeamRunsPath())) return { runs: [] };
  try {
    return JSON.parse(readFileSync(getTeamRunsPath(), 'utf-8')) as TeamRunStore;
  } catch (error) {
    logger.error('Failed to load team runs, returning empty store', {
      error: String(error),
      path: getTeamRunsPath(),
    });
    return { runs: [] };
  }
}

function saveTeamRun(run: TeamRun): void {
  const store = loadTeamRuns();
  const updatedStore: TeamRunStore = {
    runs: [...store.runs, run],
  };
  const tmpPath = `${getTeamRunsPath()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(updatedStore, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, getTeamRunsPath());
}

function getSprintScript(): string {
  return getConfig().sprintScript;
}
function getRadlDir(): string {
  return getConfig().radlDir;
}

function runSprint(args: string[]): string {
  try {
    return execFileSync(getSprintScript(), args, {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, PATH: process.env.PATH },
    }).trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Sprint command failed';
    logger.error('Sprint command failed', { args, error: msg });
    return `Error: ${msg}`;
  }
}

function getCurrentBranch(): string {
  try {
    return execSync('git branch --show-current', {
      encoding: 'utf-8',
      cwd: getRadlDir(),
      timeout: 5000,
    }).trim();
  } catch {
    return 'unknown';
  }
}

interface TeamSuggestion {
  recipe: string;
  reason: string;
}

function getTeamSuggestion(
  title: string,
  taskCount: number | undefined,
  teamRuns: TeamRunStore
): string {
  const suggestions: TeamSuggestion[] = [];
  const titleLower = title.toLowerCase();

  // Suggest sprint_advisor for 3+ tasks
  if (taskCount && taskCount >= 3) {
    suggestions.push({
      recipe: 'sprint_advisor',
      reason: `${taskCount} tasks detected — run \`sprint_advisor\` to check if a team would help`,
    });
  }

  // Keyword matching for specific recipes
  const keywordMap: Array<{ keywords: string[]; recipe: string; label: string }> = [
    { keywords: ['review', 'audit', 'security'], recipe: 'review', label: 'review recipe' },
    { keywords: ['migration', 'schema', 'database'], recipe: 'migration', label: 'migration recipe' },
    { keywords: ['refactor', 'cleanup', 'tech debt'], recipe: 'refactor', label: 'refactor recipe' },
    { keywords: ['test', 'coverage'], recipe: 'test-coverage', label: 'test-coverage recipe' },
  ];

  for (const { keywords, recipe, label } of keywordMap) {
    if (keywords.some(kw => titleLower.includes(kw))) {
      suggestions.push({
        recipe,
        reason: `Title suggests ${label} — run \`team_recipe(recipe: "${recipe}")\` for a team setup`,
      });
      break; // Only match first keyword group
    }
  }

  // Historical context
  const successful = teamRuns.runs.filter(r => r.outcome === 'success');
  if (successful.length > 0) {
    const last = successful[successful.length - 1];
    suggestions.push({
      recipe: last.recipe,
      reason: `Last successful team: ${last.recipe} recipe in ${last.sprintPhase} (${last.duration})`,
    });
  }

  if (suggestions.length === 0) return '';

  const lines = ['\nTeam suggestion:'];
  for (const s of suggestions) {
    lines.push(`  - ${s.reason}`);
  }
  return lines.join('\n');
}

export function registerSprintTools(server: McpServer): void {
  server.tool(
    'sprint_status',
    'Get current sprint status including phase, tasks completed, blockers, and git branch',
    {},
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    withErrorTracking('sprint_status', async () => {
      const branch = getCurrentBranch();
      const branchWarning = (branch === 'main' || branch === 'master')
        ? `\nWARNING: On '${branch}' branch! Create a feature branch before making changes.\n`
        : '';

      const output = runSprint(['status']);
      return { content: [{ type: 'text' as const, text: `Branch: ${branch}${branchWarning}\n${output}` }] };
    })
  );

  server.tool(
    'sprint_start',
    'Start a new sprint. Checks iron laws (branch must not be main). Sends Slack notification. Example: { "phase": "Phase 60", "title": "Auth Improvements", "estimate": "2 hours" }',
    {
      phase: z.string().min(1).max(50).describe('Sprint phase identifier (e.g., "Phase 54.1")'),
      title: z.string().min(1).max(100).describe('Sprint title (e.g., "MCP Server Migration")'),
      estimate: z.string().max(50).optional().describe('Time estimate (e.g., "3 hours")'),
      task_count: z.number().int().min(0).optional().describe('Number of planned tasks (0 or omitted triggers advisory warning)'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    withErrorTracking('sprint_start', async ({ phase, title, estimate, task_count }) => {
      // Iron law check: verify we're on a feature branch
      const branch = getCurrentBranch();
      const lawCheck = checkIronLaws({
        action: 'git_push',
        toolName: 'sprint_start',
        gitBranch: branch,
      });

      if (!lawCheck.passed) {
        const violations = lawCheck.violations.map(v => `  - ${v.description}: ${v.message}`).join('\n');
        return {
          content: [{
            type: 'text' as const,
            text: `BLOCKED by iron law:\n${violations}\n\nCreate a feature branch first:\n  cd ${getRadlDir()} && git checkout -b feat/${phase.toLowerCase().replace(/\s+/g, '-')}`,
          }],
        };
      }

      const args = ['start', phase, title];
      if (estimate) args.push(estimate);
      const output = runSprint(args);

      // Tag all subsequent API calls with this sprint phase
      setCurrentSprintPhase(phase);

      const taskAdvisory = (!task_count || task_count === 0)
        ? 'WARNING: No task breakdown provided. Create a task list (TaskCreate) before starting work to prevent scope creep.\n\n'
        : `Task plan: ${task_count} tasks\n`;

      const teamSuggestion = getTeamSuggestion(title, task_count, loadTeamRuns());

      return { content: [{ type: 'text' as const, text: `${taskAdvisory}Branch: ${branch}\n${output}${teamSuggestion}` }] };
    })
  );

  server.tool(
    'sprint_progress',
    'Record task completion in the current sprint',
    {
      message: z.string().min(1).max(500).describe('Description of completed task'),
      notify: z.boolean().optional().default(false).describe('Send Slack notification'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    withErrorTracking('sprint_progress', async ({ message, notify }) => {
      const args = ['progress', message];
      if (notify) args.push('--notify');
      const output = runSprint(args);
      return { content: [{ type: 'text' as const, text: output }] };
    })
  );

  server.tool(
    'sprint_complete',
    'Complete the current sprint. Triggers compound learning extraction and Slack notification. Optionally tracks deferred items.',
    {
      commit: z.string().min(1).max(100).describe('Commit hash of the final commit'),
      actual_time: z.string().min(1).max(50).describe('Actual time taken (e.g., "1.5 hours")'),
      deferred_items: z.array(z.object({
        title: z.string().min(1).max(200),
        reason: z.string().min(1).max(500),
        effort: z.enum(['small', 'medium', 'large']),
      })).optional().describe('Items deferred from this sprint to track for future work'),
      team_used: z.object({
        recipe: z.string().max(50),
        teammateCount: z.number().int().min(1).max(10),
        model: z.string().max(50),
        duration: z.string().max(50),
        findingsCount: z.number().int().optional(),
        tasksCompleted: z.number().int().optional(),
        outcome: z.enum(['success', 'partial', 'failed']),
        lessonsLearned: z.string().max(500).optional(),
      }).optional().describe('Track agent team usage for performance memory'),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    withErrorTracking('sprint_complete', async ({ commit, actual_time, deferred_items, team_used }) => {
      const output = runSprint(['complete', commit, actual_time]);

      // Clear sprint phase tag for cost tracking
      setCurrentSprintPhase(null);

      let deferredNote = '';
      if (deferred_items && deferred_items.length > 0) {
        const store = loadDeferred();
        const nextId = store.items.length > 0
          ? Math.max(...store.items.map(i => i.id)) + 1
          : 1;

        // Get current sprint phase from the sprint output (best-effort parse)
        const phaseMatch = output.match(/Phase\s+[\d.]+/i);
        const sprintPhase = phaseMatch ? phaseMatch[0] : 'Unknown';

        const newItems: DeferredItem[] = deferred_items.map((item, idx) => ({
          id: nextId + idx,
          title: item.title,
          reason: item.reason,
          effort: item.effort,
          sprintPhase,
          date: new Date().toISOString(),
          resolved: false,
        }));

        const updatedStore: DeferredStore = {
          items: [...store.items, ...newItems],
        };
        saveDeferred(updatedStore);

        deferredNote = `\nDeferred items: ${deferred_items.length} (tracked in knowledge/deferred.json)`;
        logger.info('Deferred items tracked', { count: deferred_items.length, sprintPhase });
      }

      let teamNote = '';
      if (team_used) {
        const store = loadTeamRuns();
        const nextId = store.runs.length > 0
          ? Math.max(...store.runs.map(r => r.id)) + 1
          : 1;

        const phaseMatch = output.match(/Phase\s+[\d.]+/i);
        const sprintPhase = phaseMatch ? phaseMatch[0] : 'Unknown';

        const teamRun: TeamRun = {
          id: nextId,
          sprintPhase,
          recipe: team_used.recipe,
          teammateCount: team_used.teammateCount,
          model: team_used.model,
          duration: team_used.duration,
          findingsCount: team_used.findingsCount,
          tasksCompleted: team_used.tasksCompleted,
          outcome: team_used.outcome,
          lessonsLearned: team_used.lessonsLearned,
          date: new Date().toISOString(),
        };

        saveTeamRun(teamRun);
        teamNote = `\nTeam run tracked: ${team_used.recipe} recipe, ${team_used.teammateCount} teammates, outcome: ${team_used.outcome}`;
        logger.info('Team run tracked', { id: nextId, recipe: team_used.recipe, outcome: team_used.outcome });
      }

      return { content: [{ type: 'text' as const, text: `${output}${deferredNote}${teamNote}` }] };
    })
  );

  // Expose iron laws as a queryable tool
  server.tool(
    'iron_laws',
    'List all iron laws (non-negotiable constraints). Use this to check what rules must never be violated.',
    {},
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    withErrorTracking('iron_laws', async () => {
      const laws = getIronLaws();
      const branch = getCurrentBranch();
      const lines = [
        'Iron Laws (NEVER violate):',
        '',
        ...laws.map((law, i) => `  ${i + 1}. [${law.severity.toUpperCase()}] ${law.description}`),
        '',
        `Current branch: ${branch}`,
        (branch === 'main' || branch === 'master')
          ? 'WARNING: On protected branch! Create a feature branch.'
          : 'OK: On feature branch.',
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    })
  );
}
