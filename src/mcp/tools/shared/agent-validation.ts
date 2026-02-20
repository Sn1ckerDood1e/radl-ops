/**
 * Agent Task Size Validator & Wave Dispatch Formatter
 *
 * Validates whether a decomposed task is appropriately sized
 * for dispatch to a single agent. Prevents token limit failures
 * by estimating token usage from file counts.
 *
 * Also generates structured dispatch blocks per wave for the
 * sprint conductor output, providing ready-to-execute Task()
 * commands for parallel, sequential, review, and conflict waves.
 *
 * Heuristic: each file ~5000 tokens (read + write).
 * Max 5 files, max 50k tokens per agent.
 */

import type { DecomposedTask } from './decomposition.js';

export interface ParallelWave {
  waveNumber: number;
  tasks: DecomposedTask[];
  fileConflicts: string[];
  hasConflicts: boolean;
  isReviewCheckpoint?: boolean;
}

export interface AgentTaskValidation {
  isValid: boolean;
  fileCount: number;
  estimatedTokens: number;
  recommendation: 'dispatch' | 'split' | 'leader-only';
  reason?: string;
}

const TOKENS_PER_FILE = 5000;
const MAX_FILES_PER_AGENT = 5;
const MAX_TOKENS_PER_AGENT = 50_000;

export function validateAgentTaskSize(task: DecomposedTask): AgentTaskValidation {
  const fileCount = task.files.length;
  const estimatedTokens = fileCount * TOKENS_PER_FILE;

  if (fileCount === 0) {
    return {
      isValid: false,
      fileCount,
      estimatedTokens: 0,
      recommendation: 'leader-only',
      reason: 'No files listed — cannot dispatch to agent without file ownership.',
    };
  }

  if (fileCount <= MAX_FILES_PER_AGENT && estimatedTokens <= MAX_TOKENS_PER_AGENT) {
    return {
      isValid: true,
      fileCount,
      estimatedTokens,
      recommendation: 'dispatch',
    };
  }

  if (fileCount > MAX_FILES_PER_AGENT) {
    return {
      isValid: false,
      fileCount,
      estimatedTokens,
      recommendation: 'split',
      reason: `${fileCount} files exceeds agent limit of ${MAX_FILES_PER_AGENT}. Split into ${Math.ceil(fileCount / 4)} sub-tasks.`,
    };
  }

  return {
    isValid: false,
    fileCount,
    estimatedTokens,
    recommendation: 'split',
    reason: `Estimated ${estimatedTokens} tokens exceeds agent limit of ${MAX_TOKENS_PER_AGENT}.`,
  };
}

export function formatAgentDispatchSection(tasks: DecomposedTask[]): string {
  const lines: string[] = ['### Agent Dispatch Recommendations', ''];

  for (const task of tasks) {
    const validation = validateAgentTaskSize(task);
    const icon = validation.isValid ? 'OK' : 'WARN';
    const rec = validation.recommendation.toUpperCase();
    lines.push(`- **#${task.id}** [${icon}] ${rec}: ${validation.fileCount} files, ~${validation.estimatedTokens} tokens${validation.reason ? ` — ${validation.reason}` : ''}`);
  }

  return lines.join('\n');
}

function formatTaskPrompt(task: DecomposedTask, feature: string): string {
  const fileList = task.files.join(', ');
  return `Sprint task: ${task.title}. ${task.description}\\nFiles you own (ONLY modify these): ${fileList}\\nFeature context: ${feature}\\nAfter implementing: run 'cd /home/hb/radl && npx tsc --noEmit' to verify.`;
}

export function formatWaveDispatchBlock(wave: ParallelWave, feature: string): string {
  const lines: string[] = [];

  if (wave.isReviewCheckpoint) {
    lines.push(`### Wave ${wave.waveNumber} — REVIEW CHECKPOINT`);
    lines.push('');
    lines.push('```');
    lines.push('Task(subagent_type="code-reviewer", run_in_background=true, model="sonnet",');
    lines.push('     prompt="Review git diff for the last wave of commits. Check for: type errors, missing validation, API misuse, dead code.")');
    lines.push('Task(subagent_type="security-reviewer", run_in_background=true, model="sonnet",');
    lines.push('     prompt="Security spot-check git diff. Check for: auth bypass, data leaks, injection, missing team-scoped queries, CSRF headers.")');
    lines.push('```');
    lines.push('');
    lines.push('Fix CRITICAL/HIGH findings before proceeding.');
    lines.push('');
    return lines.join('\n');
  }

  const taskCount = wave.tasks.length;

  if (taskCount === 1) {
    const task = wave.tasks[0];
    lines.push(`### Wave ${wave.waveNumber} (1 task — SEQUENTIAL)`);
    lines.push(`Task: #${task.id} ${task.title}`);
    lines.push('Execute directly — no agent dispatch needed.');
    lines.push('');
    return lines.join('\n');
  }

  if (wave.hasConflicts) {
    const taskList = wave.tasks.map(t => `#${t.id} ${t.title}`).join(', ');
    const conflictFiles = wave.fileConflicts.join(', ');
    lines.push(`### Wave ${wave.waveNumber} (${taskCount} tasks — SEQUENTIAL: file conflicts)`);
    lines.push(`Tasks: ${taskList}`);
    lines.push(`**FILE CONFLICTS:** ${conflictFiles} — execute these tasks sequentially.`);
    lines.push('');
    return lines.join('\n');
  }

  // Parallel dispatch: 2+ tasks, no file conflicts
  const taskList = wave.tasks.map(t => `#${t.id} ${t.title}`).join(', ');
  lines.push(`### Wave ${wave.waveNumber} (${taskCount} tasks — PARALLEL DISPATCH)`);
  lines.push(`Tasks: ${taskList}`);
  lines.push('No file conflicts.');
  lines.push('');
  lines.push('**Agent Spawn Commands:**');
  lines.push('```');
  for (const task of wave.tasks) {
    const prompt = formatTaskPrompt(task, feature);
    lines.push(`Task(subagent_type="general-purpose", run_in_background=true, model="sonnet",`);
    lines.push(`     prompt="${prompt}")`);
  }
  lines.push('```');
  lines.push('');
  lines.push('**After all agents complete:**');
  lines.push('1. Read each agent\'s output');
  lines.push('2. Run `npm run typecheck` to catch cross-cutting issues');
  lines.push('3. Commit per-task: `git add <files> && git commit -m "<type>(<scope>): <title>"`');
  lines.push('4. Call `sprint_progress` for each completed task');
  lines.push('');

  return lines.join('\n');
}

export function formatDispatchSummary(waves: ParallelWave[]): string {
  const parallelWaves = waves.filter(w => !w.isReviewCheckpoint && !w.hasConflicts && w.tasks.length >= 2);
  const totalAgents = parallelWaves.reduce((sum, w) => sum + w.tasks.length, 0);
  const sequentialWaves = waves.filter(w => !w.isReviewCheckpoint && (w.tasks.length === 1 || w.hasConflicts));
  const reviewWaves = waves.filter(w => w.isReviewCheckpoint);

  const lines: string[] = [
    '### Team Summary',
    '',
    `- **Parallel waves:** ${parallelWaves.length} (${totalAgents} agents total)`,
    `- **Sequential waves:** ${sequentialWaves.length}`,
    `- **Review checkpoints:** ${reviewWaves.length}`,
    `- **Model:** sonnet (recommended for implementation agents)`,
  ];

  if (totalAgents > 0) {
    lines.push(`- **Pattern:** Lightweight parallel (Task + run_in_background) — no TeamCreate needed`);
  }

  lines.push('');
  return lines.join('\n');
}
