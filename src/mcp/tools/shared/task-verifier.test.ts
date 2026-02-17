import { describe, it, expect } from 'vitest';
import {
  buildVerifyPrompt,
  parseVerifyOutput,
  buildRetryPrompt,
  formatVerificationSection,
  MAX_RETRIES_PER_TASK,
} from './task-verifier.js';
import type { DecomposedTaskInput, VerifyResult } from './task-verifier.js';

describe('buildVerifyPrompt', () => {
  it('includes task title and git diff', () => {
    const task: DecomposedTaskInput = { title: 'Add login form' };
    const prompt = buildVerifyPrompt(task, '+ const x = 1;');
    expect(prompt).toContain('Add login form');
    expect(prompt).toContain('+ const x = 1;');
  });

  it('uses acceptanceCriteria when available', () => {
    const task: DecomposedTaskInput = {
      title: 'Add auth',
      description: 'Basic auth',
      acceptanceCriteria: 'Must validate JWT tokens',
    };
    const prompt = buildVerifyPrompt(task, 'diff');
    expect(prompt).toContain('Must validate JWT tokens');
  });

  it('falls back to description when no acceptanceCriteria', () => {
    const task: DecomposedTaskInput = {
      title: 'Add auth',
      description: 'Implement login and signup',
    };
    const prompt = buildVerifyPrompt(task, 'diff');
    expect(prompt).toContain('Implement login and signup');
  });

  it('falls back to title when no description or criteria', () => {
    const task: DecomposedTaskInput = { title: 'Quick fix' };
    const prompt = buildVerifyPrompt(task, 'diff');
    expect(prompt).toContain('Acceptance criteria: Quick fix');
  });

  it('includes file list when files provided', () => {
    const task: DecomposedTaskInput = {
      title: 'Fix bug',
      files: ['src/auth.ts', 'src/login.ts'],
    };
    const prompt = buildVerifyPrompt(task, 'diff');
    expect(prompt).toContain('Expected files: src/auth.ts, src/login.ts');
  });

  it('omits file list when no files', () => {
    const task: DecomposedTaskInput = { title: 'Fix bug' };
    const prompt = buildVerifyPrompt(task, 'diff');
    expect(prompt).not.toContain('Expected files');
  });
});

describe('parseVerifyOutput', () => {
  it('parses pass status', () => {
    const result = parseVerifyOutput('STATUS: pass');
    expect(result.status).toBe('pass');
    expect(result.issues).toBeUndefined();
  });

  it('parses fail status with issues', () => {
    const result = parseVerifyOutput(
      'STATUS: fail\nISSUES: Missing error handling; No tests added',
    );
    expect(result.status).toBe('fail');
    expect(result.issues).toEqual(['Missing error handling', 'No tests added']);
  });

  it('parses retry status with feedback', () => {
    const result = parseVerifyOutput(
      'STATUS: retry\nISSUES: Missing validation\nFEEDBACK: Add Zod schema',
    );
    expect(result.status).toBe('retry');
    expect(result.issues).toEqual(['Missing validation']);
    expect(result.feedback).toBe('Add Zod schema');
  });

  it('defaults to retry for unknown status', () => {
    const result = parseVerifyOutput('STATUS: something_else');
    expect(result.status).toBe('retry');
  });

  it('defaults to retry when no STATUS field', () => {
    const result = parseVerifyOutput('Some random text');
    expect(result.status).toBe('retry');
  });
});

describe('buildRetryPrompt', () => {
  const verifyResult: VerifyResult = {
    status: 'retry',
    issues: ['Missing error handling'],
    feedback: 'Add try/catch around API calls',
  };

  it('replaces {{verify_feedback}} placeholder', () => {
    const original = 'Do the task\n\n{{verify_feedback}}';
    const result = buildRetryPrompt(original, verifyResult);
    expect(result).not.toContain('{{verify_feedback}}');
    expect(result).toContain('Missing error handling');
    expect(result).toContain('Add try/catch around API calls');
  });

  it('appends feedback when no placeholder', () => {
    const original = 'Do the task';
    const result = buildRetryPrompt(original, verifyResult);
    expect(result).toContain('Do the task');
    expect(result).toContain('Verification Feedback');
    expect(result).toContain('Missing error handling');
  });

  it('includes status in feedback section', () => {
    const result = buildRetryPrompt('Prompt', verifyResult);
    expect(result).toContain('**Status:** retry');
  });
});

describe('formatVerificationSection', () => {
  it('includes retry count', () => {
    const section = formatVerificationSection();
    expect(section).toContain(`max ${MAX_RETRIES_PER_TASK} retries`);
  });

  it('includes all status values', () => {
    const section = formatVerificationSection();
    expect(section).toContain('pass');
    expect(section).toContain('retry');
    expect(section).toContain('fail');
  });

  it('includes KEY:VALUE protocol reference', () => {
    const section = formatVerificationSection();
    expect(section).toContain('STATUS:');
    expect(section).toContain('ISSUES:');
    expect(section).toContain('FEEDBACK:');
  });
});

describe('MAX_RETRIES_PER_TASK', () => {
  it('is 2', () => {
    expect(MAX_RETRIES_PER_TASK).toBe(2);
  });
});
