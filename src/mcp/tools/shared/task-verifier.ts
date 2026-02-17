/**
 * Per-Task Verify-Then-Retry Protocol (Antfarm Pattern)
 *
 * Lightweight verification protocol for post-task validation.
 * The conductor's execution plan references this so that executing
 * agents (sprint-execute or manual workflows) can verify each task
 * after commit and optionally retry with feedback.
 *
 * Protocol:
 * 1. After each task commit, run verify prompt against git diff
 * 2. If STATUS: retry, re-attempt with {{verify_feedback}} injected
 * 3. Max 2 retries per task (Antfarm default)
 */

import { parseAgentOutput } from './agent-output-parser.js';

// ============================================
// Types
// ============================================

export interface VerifyResult {
  status: 'pass' | 'retry' | 'fail';
  issues?: string[];
  feedback?: string;
}

export interface DecomposedTaskInput {
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  files?: string[];
}

// ============================================
// Constants
// ============================================

export const MAX_RETRIES_PER_TASK = 2;

// ============================================
// Core Logic
// ============================================

/**
 * Build a verification prompt for a completed task.
 * The executing agent sends this to a reviewer model after committing.
 */
export function buildVerifyPrompt(task: DecomposedTaskInput, gitDiff: string): string {
  const criteria = task.acceptanceCriteria ?? task.description ?? task.title;
  const fileList = task.files?.length
    ? `\nExpected files: ${task.files.join(', ')}`
    : '';

  return `Verify this completed task:
Title: ${task.title}
Acceptance criteria: ${criteria}${fileList}

Git diff:
${gitDiff}

Check: Does the diff satisfy the acceptance criteria?
If issues found, respond with:
STATUS: retry
ISSUES: <description of what's wrong>
FEEDBACK: <specific guidance for fixing>

If all good, respond with:
STATUS: pass

If the task is fundamentally wrong and should not be retried, respond with:
STATUS: fail
ISSUES: <description of what's wrong>`;
}

/**
 * Parse the output of a verification check.
 * Accepts KEY:VALUE formatted output (Antfarm pattern).
 */
export function parseVerifyOutput(output: string): VerifyResult {
  const parsed = parseAgentOutput(output);

  const rawStatus = (parsed.status ?? '').toLowerCase().trim();
  let status: VerifyResult['status'];

  if (rawStatus === 'pass') {
    status = 'pass';
  } else if (rawStatus === 'fail') {
    status = 'fail';
  } else {
    status = 'retry';
  }

  const issues = parsed.issues
    ? parsed.issues.split(/[,;\n]/).map(s => s.trim()).filter(Boolean)
    : undefined;

  const feedback = parsed.feedback ?? undefined;

  return { status, issues, feedback };
}

/**
 * Build a retry prompt that injects verification feedback.
 * The placeholder {{verify_feedback}} is replaced with actual feedback.
 */
export function buildRetryPrompt(
  originalPrompt: string,
  verifyResult: VerifyResult,
): string {
  const feedbackSection = [
    '## Verification Feedback (from previous attempt)',
    '',
    `**Status:** ${verifyResult.status}`,
    verifyResult.issues?.length
      ? `**Issues:**\n${verifyResult.issues.map(i => `- ${i}`).join('\n')}`
      : '',
    verifyResult.feedback
      ? `**Guidance:** ${verifyResult.feedback}`
      : '',
    '',
    'Please address the issues above and try again.',
  ].filter(Boolean).join('\n');

  // Replace placeholder if present, otherwise append
  if (originalPrompt.includes('{{verify_feedback}}')) {
    return originalPrompt.replace('{{verify_feedback}}', feedbackSection);
  }

  return `${originalPrompt}\n\n${feedbackSection}`;
}

/**
 * Format verification section for conductor execution plan output.
 * This tells the executing agent how to verify each task.
 */
export function formatVerificationSection(): string {
  return `## Task Verification Protocol

After each task commit, verify the work:
1. Run the verify prompt against \`git diff HEAD~1\`
2. If STATUS: retry, re-attempt with the feedback injected (max ${MAX_RETRIES_PER_TASK} retries)
3. If STATUS: fail, stop and escalate
4. If STATUS: pass, proceed to next task

Agents should output structured KEY:VALUE pairs:
\`\`\`
STATUS: pass|retry|fail
ISSUES: description of problems (if any)
FEEDBACK: specific fix guidance (if retry)
FILES_CHANGED: N
TESTS_PASSED: N
\`\`\``;
}
