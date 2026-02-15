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
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../../config/logger.js';
import { checkIronLaws, getIronLaws } from '../../guardrails/iron-laws.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { setCurrentSprintPhase } from '../../models/token-tracker.js';
import type { TeamRun, TeamRunStore } from '../../types/index.js';
import { getConfig } from '../../config/paths.js';
import { notifySprintChanged } from '../resources.js';
import { runBloomPipeline } from '../../patterns/bloom-orchestrator.js';
import type { SprintData } from '../../patterns/bloom-orchestrator.js';

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

function getDeferredTriageSummary(): string {
  const store = loadDeferred();
  const unresolved = (store.items || []).filter(i => !i.resolved);
  if (unresolved.length === 0) return '';

  // Sort by date ascending (oldest first)
  const sorted = [...unresolved].sort((a, b) =>
    new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  const now = new Date();
  const oldest = sorted.slice(0, 3).map(item => {
    const ageDays = Math.floor(
      (now.getTime() - new Date(item.date).getTime()) / (1000 * 60 * 60 * 24)
    );
    return `  - [${item.effort}] ${item.title} (${ageDays}d old, from ${item.sprintPhase})`;
  });

  return `\nDeferred triage (${unresolved.length} unresolved, oldest 3):\n${oldest.join('\n')}`;
}

function normalizeSprintData(raw: Record<string, unknown>): SprintData {
  return {
    phase: String(raw.phase ?? 'Unknown'),
    title: String(raw.title ?? 'Unknown'),
    status: String(raw.status ?? 'Unknown'),
    completedTasks: Array.isArray(raw.completedTasks) ? raw.completedTasks : [],
    blockers: Array.isArray(raw.blockers) ? raw.blockers : [],
    estimate: String(raw.estimate ?? 'Unknown'),
    actual: String(raw.actualTime ?? raw.actual ?? 'Unknown'),
  };
}

function loadExistingKnowledgeForExtract(knowledgeDir: string): string {
  const sections: string[] = [];

  const patternsPath = join(knowledgeDir, 'patterns.json');
  if (existsSync(patternsPath)) {
    try {
      const data = JSON.parse(readFileSync(patternsPath, 'utf-8'));
      const names = (data.patterns || []).slice(0, 15).map((p: { name: string; description: string }) =>
        `- ${p.name}: ${p.description}`
      );
      if (names.length > 0) {
        sections.push('## Existing Patterns', ...names, '');
      }
    } catch {
      // Ignore parse errors
    }
  }

  const lessonsPath = join(knowledgeDir, 'lessons.json');
  if (existsSync(lessonsPath)) {
    try {
      const data = JSON.parse(readFileSync(lessonsPath, 'utf-8'));
      const items = (data.lessons || []).slice(-15).map((l: { situation: string; learning: string }) =>
        `- ${l.situation}: ${l.learning}`
      );
      if (items.length > 0) {
        sections.push('## Existing Lessons', ...items, '');
      }
    } catch {
      // Ignore parse errors
    }
  }

  return sections.join('\n');
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
      const statusText = `Branch: ${branch}${branchWarning}\n${output}`;

      // Parse sprint output for structured content (best-effort)
      const phaseMatch = output.match(/Phase:\s*(.+)/i);
      const titleMatch = output.match(/Title:\s*(.+)/i);
      const statusMatch = output.match(/Status:\s*(.+)/i);

      return {
        content: [{ type: 'text' as const, text: statusText }],
        structuredContent: {
          branch,
          onProtectedBranch: branch === 'main' || branch === 'master',
          phase: phaseMatch?.[1]?.trim(),
          title: titleMatch?.[1]?.trim(),
          status: statusMatch?.[1]?.trim(),
          rawOutput: output,
        },
      };
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
      const deferredTriage = getDeferredTriageSummary();

      notifySprintChanged();

      return { content: [{ type: 'text' as const, text: `${taskAdvisory}Branch: ${branch}\n${output}${teamSuggestion}${deferredTriage}` }] };
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
      notifySprintChanged();
      return { content: [{ type: 'text' as const, text: output }] };
    })
  );

  server.tool(
    'sprint_complete',
    'Complete the current sprint. Auto-extracts compound learnings via Bloom pipeline, sends Slack notification, and optionally tracks deferred items and team usage.',
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
      auto_extract: z.boolean().optional().default(true)
        .describe('Auto-run compound learning extraction via Bloom pipeline (default: true)'),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    withErrorTracking('sprint_complete', async ({ commit, actual_time, deferred_items, team_used, auto_extract }) => {
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

      notifySprintChanged();

      // Auto-extract compound learnings via Bloom pipeline
      let extractNote = '';
      if (auto_extract !== false) {
        try {
          const sprintDir = join(getConfig().radlDir, '.planning/sprints');
          const knowledgeDir = getConfig().knowledgeDir;

          // Find sprint data (check archive first, then current)
          let sprintData: SprintData | null = null;
          const archiveDir = join(sprintDir, 'archive');

          if (existsSync(archiveDir)) {
            const files = execSync(`ls -1 "${archiveDir}" 2>/dev/null || true`, {
              encoding: 'utf-8',
              timeout: 5000,
            }).trim().split('\n').filter(f => f.endsWith('.json')).sort().reverse();

            if (files.length > 0) {
              const raw = JSON.parse(readFileSync(join(archiveDir, files[0]), 'utf-8'));
              sprintData = normalizeSprintData(raw);
            }
          }

          if (!sprintData) {
            const currentPath = join(sprintDir, 'current.json');
            if (existsSync(currentPath)) {
              const raw = JSON.parse(readFileSync(currentPath, 'utf-8'));
              sprintData = normalizeSprintData(raw);
            }
          }

          if (sprintData) {
            // Load existing knowledge for dedup context
            const existingKnowledge = loadExistingKnowledgeForExtract(knowledgeDir);

            const bloomResult = await runBloomPipeline(sprintData, existingKnowledge);

            // Save compound file
            const compoundDir = join(knowledgeDir, 'compounds');
            if (!existsSync(compoundDir)) {
              mkdirSync(compoundDir, { recursive: true });
            }
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const compoundFile = join(compoundDir, `bloom-${timestamp}.json`);
            writeFileSync(compoundFile, JSON.stringify({
              extractedAt: new Date().toISOString(),
              method: 'bloom-pipeline-auto',
              sprintPhase: bloomResult.sprintPhase,
              sprintTitle: bloomResult.sprintTitle,
              qualityScore: bloomResult.qualityScore,
              lessons: bloomResult.lessons,
              totalCostUsd: bloomResult.totalCostUsd,
            }, null, 2));

            extractNote = `\nCompound extract: ${bloomResult.lessons.length} lessons (quality: ${bloomResult.qualityScore}/10, cost: $${bloomResult.totalCostUsd})`;
            logger.info('Auto compound extract completed', {
              lessons: bloomResult.lessons.length,
              quality: bloomResult.qualityScore,
              cost: bloomResult.totalCostUsd,
            });
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          extractNote = `\nCompound extract: skipped (${msg})`;
          logger.warn('Auto compound extract failed', { error: msg });
        }
      }

      return { content: [{ type: 'text' as const, text: `${output}${deferredNote}${teamNote}${extractNote}` }] };
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
