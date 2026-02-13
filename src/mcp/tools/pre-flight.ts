/**
 * MCP Pre-Flight Check Tool
 *
 * Zero-cost pre-push verification tool (NO AI calls, $0 cost).
 * Runs multiple checks and returns a pass/fail checklist:
 * branch safety, sprint tracking, uncommitted changes,
 * typecheck status, and secret detection.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { getConfig } from '../../config/paths.js';

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

function checkBranchSafety(): CheckResult {
  const config = getConfig();
  try {
    const branch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      cwd: config.radlDir,
      timeout: 5000,
    }).trim();

    const isProtected = branch === 'main' || branch === 'master';
    return {
      name: 'Branch',
      passed: !isProtected,
      detail: isProtected
        ? `${branch} (BLOCKED \u2014 push to feature branch!)`
        : `${branch} (not main/master)`,
    };
  } catch {
    return {
      name: 'Branch',
      passed: false,
      detail: 'Could not determine current branch',
    };
  }
}

function checkSprintTracking(): CheckResult {
  const config = getConfig();
  const currentPath = `${config.radlDir}/.planning/sprints/current.json`;

  if (!existsSync(currentPath)) {
    return {
      name: 'Sprint',
      passed: false,
      detail: 'No active sprint (current.json not found)',
    };
  }

  try {
    const data = JSON.parse(readFileSync(currentPath, 'utf-8'));
    const status = data.status || 'unknown';
    const isActive = status === 'active' || status === 'in_progress';
    const title = data.title || 'Untitled';
    const phase = data.phase || 'Unknown';

    return {
      name: 'Sprint',
      passed: isActive,
      detail: isActive
        ? `${phase} \u2014 ${title} (${status})`
        : `${phase} \u2014 ${title} (status: ${status}, expected active/in_progress)`,
    };
  } catch {
    return {
      name: 'Sprint',
      passed: false,
      detail: 'Failed to parse current.json',
    };
  }
}

function checkCleanTree(): CheckResult {
  const config = getConfig();
  try {
    const output = execSync('git status --porcelain', {
      encoding: 'utf-8',
      cwd: config.radlDir,
      timeout: 10000,
    }).trim();

    if (!output) {
      return {
        name: 'Clean tree',
        passed: true,
        detail: 'No uncommitted changes',
      };
    }

    const fileCount = output.split('\n').filter(Boolean).length;
    return {
      name: 'Clean tree',
      passed: false,
      detail: `${fileCount} uncommitted file${fileCount !== 1 ? 's' : ''}`,
    };
  } catch {
    return {
      name: 'Clean tree',
      passed: false,
      detail: 'Could not check git status',
    };
  }
}

function checkTypeCheck(): CheckResult {
  const config = getConfig();
  try {
    execSync('npx tsc --noEmit', {
      encoding: 'utf-8',
      cwd: config.radlDir,
      timeout: 60000,
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key',
        NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || 'https://placeholder.app',
        NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || 'placeholder-vapid-key',
      },
    });

    return {
      name: 'TypeCheck',
      passed: true,
      detail: 'Passed',
    };
  } catch (error) {
    const msg = error instanceof Error
      ? (error as { stderr?: string }).stderr || (error as { stdout?: string }).stdout || error.message
      : String(error);
    const errorStr = String(msg);
    // Count error lines that match TypeScript error format
    const errorLines = errorStr.split('\n').filter(l => l.includes('error TS'));
    const errorCount = errorLines.length;
    return {
      name: 'TypeCheck',
      passed: false,
      detail: errorCount > 0
        ? `${errorCount} error${errorCount !== 1 ? 's' : ''} found`
        : 'Failed (see tsc output)',
    };
  }
}

function checkSecrets(): CheckResult {
  const config = getConfig();
  const patterns = [
    'API_KEY=',
    'api_key=',
    'SECRET_KEY=',
    'secret_key=',
    'PASSWORD=',
    'password=',
    'TOKEN=',
    'token=',
    'PRIVATE_KEY=',
    'private_key=',
  ];

  try {
    // Check staged files for secret patterns
    const stagedFiles = execSync('git diff --cached --name-only', {
      encoding: 'utf-8',
      cwd: config.radlDir,
      timeout: 5000,
    }).trim();

    if (!stagedFiles) {
      return {
        name: 'Secrets scan',
        passed: true,
        detail: 'No staged files to check',
      };
    }

    const stagedDiff = execSync('git diff --cached', {
      encoding: 'utf-8',
      cwd: config.radlDir,
      timeout: 10000,
    });

    // Only check added lines (lines starting with +, excluding +++ header)
    const addedLines = stagedDiff
      .split('\n')
      .filter(l => l.startsWith('+') && !l.startsWith('+++'));

    const matches: string[] = [];
    for (const line of addedLines) {
      for (const pattern of patterns) {
        if (line.includes(pattern)) {
          matches.push(pattern.replace('=', ''));
          break;
        }
      }
    }

    const unique = [...new Set(matches)];
    if (unique.length === 0) {
      return {
        name: 'Secrets scan',
        passed: true,
        detail: 'No secrets detected',
      };
    }

    return {
      name: 'Secrets scan',
      passed: false,
      detail: `Potential secrets detected: ${unique.join(', ')}`,
    };
  } catch {
    return {
      name: 'Secrets scan',
      passed: true,
      detail: 'No staged files (clean tree)',
    };
  }
}

function formatChecklist(results: CheckResult[]): string {
  const lines: string[] = ['# Pre-Flight Checklist', ''];

  for (const r of results) {
    const icon = r.passed ? 'PASS' : 'FAIL';
    lines.push(`[${icon}] ${r.name}: ${r.detail}`);
  }

  lines.push('');

  const failCount = results.filter(r => !r.passed).length;
  if (failCount === 0) {
    lines.push('**Result:** ALL CHECKS PASSED \u2014 safe to push');
  } else {
    lines.push(`**Result:** ${failCount} CHECK${failCount !== 1 ? 'S' : ''} FAILED \u2014 fix before pushing`);
  }

  return lines.join('\n');
}

export function registerPreFlightTools(server: McpServer): void {
  server.tool(
    'pre_flight_check',
    'Run pre-push verification checklist: branch safety, sprint tracking, uncommitted changes, typecheck status, pattern drift. Zero cost (no AI calls). Example: {}',
    {},
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    withErrorTracking('pre_flight_check', async () => {
      logger.info('Pre-flight check started');

      const results: CheckResult[] = [
        checkBranchSafety(),
        checkSprintTracking(),
        checkCleanTree(),
        checkTypeCheck(),
        checkSecrets(),
      ];

      const allPassed = results.every(r => r.passed);

      logger.info('Pre-flight check complete', {
        allPassed,
        results: results.map(r => ({ name: r.name, passed: r.passed })),
      });

      const report = formatChecklist(results);

      return { content: [{ type: 'text' as const, text: report }] };
    })
  );
}
