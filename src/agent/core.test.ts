/**
 * Tests for core agent helper functions.
 * Tests pure functions only - API-dependent functions tested via integration tests.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

// Test the deterministic error key algorithm directly
// (since the function is not exported, we replicate the logic)
function buildErrorKey(toolName: string, input: Record<string, unknown>): string {
  const sortedKeys = Object.keys(input).sort();
  const stableEntries = sortedKeys
    .map(k => `${k}:${String(input[k])}`)
    .join('|');
  const hash = createHash('sha256')
    .update(stableEntries)
    .digest('hex')
    .substring(0, 12);
  return `${toolName}:${hash}`;
}

describe('buildErrorKey', () => {
  it('produces deterministic keys for same input', () => {
    const key1 = buildErrorKey('test_tool', { a: 1, b: 'hello' });
    const key2 = buildErrorKey('test_tool', { a: 1, b: 'hello' });
    expect(key1).toBe(key2);
  });

  it('produces same key regardless of object key order', () => {
    const key1 = buildErrorKey('tool', { z: 1, a: 2, m: 3 });
    const key2 = buildErrorKey('tool', { a: 2, m: 3, z: 1 });
    expect(key1).toBe(key2);
  });

  it('produces different keys for different inputs', () => {
    const key1 = buildErrorKey('tool', { a: 1 });
    const key2 = buildErrorKey('tool', { a: 2 });
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for different tool names', () => {
    const key1 = buildErrorKey('tool_a', { a: 1 });
    const key2 = buildErrorKey('tool_b', { a: 1 });
    expect(key1).not.toBe(key2);
  });

  it('includes tool name prefix', () => {
    const key = buildErrorKey('my_tool', { x: 1 });
    expect(key.startsWith('my_tool:')).toBe(true);
  });

  it('hash portion is 12 hex characters', () => {
    const key = buildErrorKey('tool', { a: 1 });
    const hash = key.split(':')[1];
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });
});

// Test iron law context building logic
describe('Iron Law Context Building', () => {
  const GIT_TOOLS = new Set([
    'git_push', 'git_commit', 'git_merge', 'git_rebase',
    'github_merge_pr', 'github_create_pr',
  ]);

  const FILE_WRITE_TOOLS = new Set([
    'file_write', 'file_edit', 'file_create',
    'github_create_file', 'github_push_files',
  ]);

  function buildIronLawContext(
    toolName: string,
    params: Record<string, unknown>
  ) {
    const context: {
      action: string;
      toolName: string;
      params: Record<string, unknown>;
      targetFile?: string;
      gitBranch?: string;
    } = {
      action: GIT_TOOLS.has(toolName)
        ? 'git_push'
        : FILE_WRITE_TOOLS.has(toolName)
          ? 'file_write'
          : 'tool_execution',
      toolName,
      params,
    };

    if (typeof params.branch === 'string') {
      context.gitBranch = params.branch;
    } else if (typeof params.ref === 'string') {
      context.gitBranch = params.ref;
    }

    if (typeof params.path === 'string') {
      context.targetFile = params.path;
    } else if (typeof params.file === 'string') {
      context.targetFile = params.file;
    } else if (typeof params.filePath === 'string') {
      context.targetFile = params.filePath;
    }

    return context;
  }

  it('detects git tools', () => {
    const ctx = buildIronLawContext('git_push', { branch: 'main' });
    expect(ctx.action).toBe('git_push');
    expect(ctx.gitBranch).toBe('main');
  });

  it('detects file write tools', () => {
    const ctx = buildIronLawContext('file_write', { path: '/home/hb/radl/.env' });
    expect(ctx.action).toBe('file_write');
    expect(ctx.targetFile).toBe('/home/hb/radl/.env');
  });

  it('defaults to tool_execution for unknown tools', () => {
    const ctx = buildIronLawContext('some_tool', {});
    expect(ctx.action).toBe('tool_execution');
  });

  it('extracts branch from ref param', () => {
    const ctx = buildIronLawContext('git_push', { ref: 'develop' });
    expect(ctx.gitBranch).toBe('develop');
  });

  it('extracts file from filePath param', () => {
    const ctx = buildIronLawContext('file_write', { filePath: 'src/index.ts' });
    expect(ctx.targetFile).toBe('src/index.ts');
  });
});
