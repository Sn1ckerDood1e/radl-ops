/**
 * Agent Task Size Validator
 *
 * Validates whether a decomposed task is appropriately sized
 * for dispatch to a single agent. Prevents token limit failures
 * by estimating token usage from file counts.
 *
 * Heuristic: each file ~5000 tokens (read + write).
 * Max 5 files, max 50k tokens per agent.
 */

import type { DecomposedTask } from './decomposition.js';

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
