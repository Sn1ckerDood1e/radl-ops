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
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'fs';
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
import { loadLatestPlan, matchCommitsToTasks, savePlan, formatTraceabilityReport } from './shared/plan-store.js';
import { extractCausalPairs } from './causal-graph.js';
import { recordTrustDecision } from './quality-ratchet.js';
import { recordCognitiveCalibration } from './cognitive-load.js';
import { clearFindings, loadFindings, checkUnresolved } from './review-tracker.js';

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

function findCompletedSprintData(sprintDir: string): Record<string, unknown> | null {
  // Check completed-*.json files directly in sprint dir
  try {
    const files = readdirSync(sprintDir)
      .filter(f => f.startsWith('completed-') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length > 0) {
      return JSON.parse(readFileSync(join(sprintDir, files[0]), 'utf-8'));
    }
  } catch { /* non-fatal */ }

  // Fall back to current.json
  const currentPath = join(sprintDir, 'current.json');
  if (existsSync(currentPath)) {
    try {
      return JSON.parse(readFileSync(currentPath, 'utf-8'));
    } catch { /* non-fatal */ }
  }
  return null;
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

/**
 * Compare validation warnings from the plan against actual git changes.
 * Returns a report of which warnings appear addressed and records a trust decision.
 */
function compareValidationWarnings(
  plan: { validationWarnings?: string[] },
  radlDir: string,
  sprintPhase: string,
): string {
  if (!plan.validationWarnings || plan.validationWarnings.length === 0) {
    return '';
  }

  const warnings = plan.validationWarnings;

  // Get files changed on this branch vs main
  let changedFiles: string[];
  try {
    const diffStat = execSync('git diff main...HEAD --name-only 2>/dev/null || true', {
      encoding: 'utf-8',
      cwd: radlDir,
      timeout: 5000,
    }).trim();
    changedFiles = diffStat.split('\n').filter(Boolean);
  } catch {
    return '';
  }

  if (changedFiles.length === 0) return '';

  // For each warning, check if the flagged category was addressed
  const layerPatterns: Record<string, string[]> = {
    'migration': ['supabase/migrations/', 'prisma/migrations/'],
    'validation': ['src/lib/validations/'],
    'api-handler': ['src/app/api/'],
    'client-component': ['src/components/', 'src/app/('],
  };

  let addressed = 0;
  const details: string[] = [];

  for (const warning of warnings) {
    // Extract missing layers from data-flow-coverage warnings
    const missingMatch = warning.match(/missing:\s*(.+)/i);
    if (missingMatch) {
      const missingLayers = missingMatch[1].split(',').map(l => l.trim());
      const fixed = missingLayers.filter(layer => {
        const patterns = layerPatterns[layer];
        if (!patterns) return false;
        return changedFiles.some(f => patterns.some(p => f.includes(p)));
      });

      if (fixed.length === missingLayers.length) {
        addressed++;
        details.push(`  [FIXED] ${warning.substring(0, 80)}`);
      } else if (fixed.length > 0) {
        details.push(`  [PARTIAL] ${warning.substring(0, 80)} (${fixed.length}/${missingLayers.length} layers)`);
      } else {
        details.push(`  [OPEN] ${warning.substring(0, 80)}`);
      }
    } else {
      // For non-data-flow warnings, mark as not determinable
      details.push(`  [REVIEW] ${warning.substring(0, 80)}`);
    }
  }

  // Record trust decision for speculative validation accuracy
  const outcome = addressed === warnings.length
    ? 'success'
    : addressed > 0
      ? 'partial'
      : 'failure';

  recordTrustDecision({
    domain: 'speculative_validation',
    decision: `${addressed}/${warnings.length} warnings addressed`,
    aiRecommended: `${warnings.length} pre-sprint warnings flagged`,
    humanOverride: false,
    outcome,
    sprint: sprintPhase,
  });

  const lines = [
    `\n### Validation Warning Follow-up`,
    `**Pre-sprint warnings:** ${warnings.length} | **Addressed:** ${addressed}`,
    ...details,
  ];

  return lines.join('\n');
}

function parseTimeToMinutes(timeStr: string): number {
  const hourMatch = timeStr.match(/(\d+(?:\.\d+)?)\s*h/i);
  const minMatch = timeStr.match(/(\d+)\s*m/i);
  let total = 0;
  if (hourMatch) total += parseFloat(hourMatch[1]) * 60;
  if (minMatch) total += parseInt(minMatch[1], 10);
  return total;
}

// Exported for testing
export { compareValidationWarnings };

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

      // Clear previous review findings for new sprint
      clearFindings();

      const taskAdvisory = (!task_count || task_count === 0)
        ? 'WARNING: No task breakdown provided. Create a task list (TaskCreate) before starting work to prevent scope creep.\n\n'
        : `Task plan: ${task_count} tasks\n`;

      const teamSuggestion = getTeamSuggestion(title, task_count, loadTeamRuns());
      const deferredTriage = getDeferredTriageSummary();

      let cognitiveAdvisory = '';
      if (task_count && task_count >= 5) {
        cognitiveAdvisory = '\nCONTEXT BUDGET: Run cognitive_load MCP tool — ' + task_count +
          ' tasks may exceed context window. Predict compaction timing before starting.';
      } else if (task_count && task_count >= 3) {
        cognitiveAdvisory = '\nTIP: Run cognitive_load MCP tool to predict context window usage.';
      }

      notifySprintChanged();

      return { content: [{ type: 'text' as const, text: `${taskAdvisory}Branch: ${branch}\n${output}${teamSuggestion}${deferredTriage}${cognitiveAdvisory}` }] };
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

          // Find sprint data (completed-*.json files in sprint dir)
          const raw = findCompletedSprintData(sprintDir);
          const sprintData = raw ? normalizeSprintData(raw) : null;

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

      // Auto-invoke causal extraction
      if (auto_extract !== false) {
        try {
          const sprintDir = join(getConfig().radlDir, '.planning/sprints');
          const causalRaw = findCompletedSprintData(sprintDir);
          const sprintData = causalRaw ? normalizeSprintData(causalRaw) : null;

          if (sprintData) {
            const causalResult = await extractCausalPairs({
              phase: sprintData.phase,
              title: sprintData.title,
              completedTasks: sprintData.completedTasks,
              blockers: sprintData.blockers,
              estimate: sprintData.estimate,
              actual: actual_time,
            });
            logger.info('Auto causal extraction complete', causalResult);
          }
        } catch (error) {
          logger.warn('Auto causal extraction failed (non-fatal)', { error: String(error) });
        }
      }

      // Auto-record trust decisions at sprint boundaries
      if (auto_extract !== false) {
        // Parse sprint phase from output
        const phaseMatch = output.match(/Phase\s+[\d.]+/i);
        const sprintPhase = phaseMatch ? phaseMatch[0] : 'Unknown';

        // 1. Estimation accuracy
        try {
          const sprintDir = join(getConfig().radlDir, '.planning/sprints');
          const estimateRaw = findCompletedSprintData(sprintDir);
          const estimate = estimateRaw ? String(estimateRaw.estimate ?? '') : '';

          if (estimate && actual_time) {
            const estimateMinutes = parseTimeToMinutes(estimate);
            const actualMinutes = parseTimeToMinutes(actual_time);
            if (estimateMinutes > 0 && actualMinutes > 0) {
              const ratio = actualMinutes / estimateMinutes;
              const outcome = (ratio >= 0.7 && ratio <= 1.3) ? 'success' : (ratio >= 0.4 && ratio <= 1.6) ? 'partial' : 'failure';
              recordTrustDecision({
                domain: 'estimation',
                decision: `Actual: ${actual_time}`,
                aiRecommended: `Estimated: ${estimate}`,
                humanOverride: false,
                outcome,
                sprint: sprintPhase,
              });
            }
          }
        } catch (error) {
          logger.warn('Trust recording for estimation failed (non-fatal)', { error: String(error) });
        }

        // 2. Bloom quality (if bloom ran)
        try {
          const knowledgeDir = getConfig().knowledgeDir;
          const compoundDir = join(knowledgeDir, 'compounds');
          if (existsSync(compoundDir)) {
            const files = execSync(`ls -1 "${compoundDir}" 2>/dev/null || true`, {
              encoding: 'utf-8',
              timeout: 5000,
            }).trim().split('\n').filter(f => f.startsWith('bloom-') && f.endsWith('.json')).sort().reverse();

            if (files.length > 0) {
              const latestBloom = JSON.parse(readFileSync(join(compoundDir, files[0]), 'utf-8'));
              const qualityScore = latestBloom.qualityScore ?? 0;
              if (qualityScore > 0) {
                const outcome = qualityScore >= 7 ? 'success' : qualityScore >= 5 ? 'partial' : 'failure';
                recordTrustDecision({
                  domain: 'bloom-extraction',
                  decision: `Quality score: ${qualityScore}/10`,
                  aiRecommended: 'Target: 7/10',
                  humanOverride: false,
                  outcome,
                  sprint: sprintPhase,
                });
              }
            }
          }
        } catch (error) {
          logger.warn('Trust recording for bloom quality failed (non-fatal)', { error: String(error) });
        }
      }

      // Auto-record cognitive load calibration
      if (auto_extract !== false) {
        try {
          const sprintDir = join(getConfig().radlDir, '.planning/sprints');
          const cogRaw = findCompletedSprintData(sprintDir);
          const taskCount = cogRaw && Array.isArray(cogRaw.completedTasks) ? cogRaw.completedTasks.length : 0;

          const phaseMatch = output.match(/Phase\s+[\d.]+/i);
          const sprintPhase = phaseMatch ? phaseMatch[0] : 'Unknown';

          recordCognitiveCalibration({
            sprint: sprintPhase,
            taskCount,
            contextUsagePercent: 50, // Default estimate; can be refined later
          });
        } catch (error) {
          logger.warn('Cognitive calibration recording failed (non-fatal)', { error: String(error) });
        }
      }

      // Plan traceability report + validation warning comparison
      let traceabilityNote = '';
      let validationNote = '';
      try {
        const latestPlan = loadLatestPlan();
        if (latestPlan) {
          // Get git log commits for the sprint branch
          const commitLog = execSync('git log --oneline --format="%s" HEAD~20..HEAD 2>/dev/null || true', {
            encoding: 'utf-8',
            cwd: getConfig().radlDir,
            timeout: 5000,
          }).trim();

          if (commitLog) {
            const commits = commitLog.split('\n').filter(Boolean);
            const matched = matchCommitsToTasks(latestPlan, commits);
            savePlan(matched);
            traceabilityNote = `\n\n${formatTraceabilityReport(matched)}`;
          }

          // Compare validation warnings against actual changes
          const phaseMatch = output.match(/Phase\s+[\d.]+/i);
          const phase = phaseMatch ? phaseMatch[0] : 'Unknown';
          validationNote = compareValidationWarnings(latestPlan, getConfig().radlDir, phase);
        }
      } catch (error) {
        logger.warn('Plan traceability report failed', { error: String(error) });
      }

      // Review gate check
      let reviewNote = '';
      const findings = loadFindings();
      const hasReviews = findings.length > 0;
      const taskCountMatch = output.match(/(\d+)\s+tasks?\s+completed/i);
      const completedTaskCount = taskCountMatch ? parseInt(taskCountMatch[1], 10) : 0;
      if (completedTaskCount >= 3 && !hasReviews && !team_used?.recipe?.includes('review')) {
        reviewNote = '\nREVIEW WARNING: Sprint had ' + completedTaskCount +
          ' tasks but no reviews recorded. Run code-reviewer + security-reviewer before merging.';
      }
      const unresolved = checkUnresolved();
      if (unresolved.critical > 0 || unresolved.high > 0) {
        reviewNote += `\nUNRESOLVED FINDINGS: ${unresolved.critical} CRITICAL, ${unresolved.high} HIGH — address before merging.`;
      }

      return { content: [{ type: 'text' as const, text: `${output}${deferredNote}${teamNote}${extractNote}${traceabilityNote}${validationNote}${reviewNote}` }] };
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
