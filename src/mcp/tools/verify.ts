/**
 * MCP Verification Tool - 4-level verification system
 *
 * Level 1: Exists — Glob check for files at expected paths
 * Level 2: Substantive — Grep for TODO, placeholder, empty returns
 * Level 3: Wired — Verify imports, route registrations, component usage
 * Level 4: Functional — Build + typecheck + test run
 *
 * Default (no level): runs typecheck + build (legacy behavior).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execSync, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve, normalize } from 'path';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { getConfig } from '../../config/paths.js';

/**
 * Validate that a file path is contained within allowed directories.
 * Prevents path traversal via absolute paths or '..' sequences.
 */
function validateFilePath(file: string): string {
  const config = getConfig();
  const allowedBases = [config.radlDir, config.radlOpsDir];
  const absolute = file.startsWith('/')
    ? resolve(normalize(file))
    : resolve(config.radlDir, file);

  if (file.includes('..')) {
    throw new Error(`Path traversal not allowed: ${file}`);
  }

  const allowed = allowedBases.some(base => absolute.startsWith(base + '/') || absolute === base);
  if (!allowed) {
    throw new Error(`File path not allowed: ${file}. Must be under radlDir or radlOpsDir.`);
  }

  return absolute;
}

interface CheckResult {
  name: string;
  passed: boolean;
  output: string;
  durationMs: number;
}

function runCheck(name: string, command: string): CheckResult {
  const start = Date.now();
  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      cwd: getConfig().radlDir,
      timeout: 300000, // 5 min max
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key',
        NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || 'https://placeholder.app',
        NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || 'placeholder-vapid-key',
      },
    });
    return { name, passed: true, output: output.slice(-500), durationMs: Date.now() - start };
  } catch (error) {
    const msg = error instanceof Error ? (error as { stdout?: string; stderr?: string }).stderr || (error as { stdout?: string }).stdout || error.message : String(error);
    return { name, passed: false, output: String(msg).slice(-1000), durationMs: Date.now() - start };
  }
}

// ============================================
// Level 1: Exists — file presence check
// ============================================

function checkExists(files: string[]): CheckResult[] {
  return files.map(file => {
    const start = Date.now();
    try {
      const fullPath = validateFilePath(file);
      const found = existsSync(fullPath);
      return {
        name: `Exists: ${file}`,
        passed: found,
        output: found ? 'File found' : `NOT FOUND: ${file}`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        name: `Exists: ${file}`,
        passed: false,
        output: err instanceof Error ? err.message : 'Invalid path',
        durationMs: Date.now() - start,
      };
    }
  });
}

// ============================================
// Level 2: Substantive — grep for placeholders
// ============================================

const PLACEHOLDER_PATTERNS = [
  { pattern: 'TODO|FIXME|HACK|XXX', label: 'TODO/FIXME markers' },
  { pattern: 'placeholder|PLACEHOLDER', label: 'Placeholder text' },
  { pattern: 'return\\s*\\{\\s*ok:\\s*true\\s*\\}', label: 'Stub { ok: true } returns' },
  { pattern: 'throw new Error\\([\'"]not implemented', label: 'Not-implemented throws' },
];

function checkSubstantive(files: string[]): CheckResult[] {
  const results: CheckResult[] = [];

  for (const file of files) {
    const start = Date.now();
    let fullPath: string;
    try {
      fullPath = validateFilePath(file);
    } catch (err) {
      results.push({ name: `Substantive: ${file}`, passed: false, output: err instanceof Error ? err.message : 'Invalid path', durationMs: Date.now() - start });
      continue;
    }
    if (!existsSync(fullPath)) {
      results.push({ name: `Substantive: ${file}`, passed: false, output: 'File not found', durationMs: Date.now() - start });
      continue;
    }

    const issues: string[] = [];
    for (const { pattern, label } of PLACEHOLDER_PATTERNS) {
      try {
        const output = execFileSync('grep', ['-n', '-i', '-E', pattern, fullPath], { encoding: 'utf-8', timeout: 5000 });
        if (output.trim()) {
          issues.push(`${label}: ${output.trim().split('\n').length} occurrence(s)`);
        }
      } catch {
        // grep exits 1 when no match — that's good
      }
    }

    results.push({
      name: `Substantive: ${file}`,
      passed: issues.length === 0,
      output: issues.length > 0 ? issues.join('\n') : 'No placeholder patterns found',
      durationMs: Date.now() - start,
    });
  }

  return results;
}

// ============================================
// Level 3: Wired — verify imports and usage
// ============================================

function checkWired(files: string[]): CheckResult[] {
  const radlDir = getConfig().radlDir;
  const results: CheckResult[] = [];

  for (const file of files) {
    const start = Date.now();
    try {
      validateFilePath(file);
    } catch (err) {
      results.push({ name: `Wired: ${file}`, passed: false, output: err instanceof Error ? err.message : 'Invalid path', durationMs: Date.now() - start });
      continue;
    }

    // Check if the file is imported by at least one other file
    const basename = file.split('/').pop()?.replace(/\.(ts|tsx|js|jsx)$/, '') || file;
    try {
      const output = execFileSync('grep', ['-r', '-l', '--include=*.ts', '--include=*.tsx', basename, radlDir], { encoding: 'utf-8', timeout: 10000 });
      const importers = output.trim().split('\n').filter(f => f && !f.endsWith(file));
      results.push({
        name: `Wired: ${file}`,
        passed: importers.length > 0,
        output: importers.length > 0
          ? `Imported by ${importers.length} file(s): ${importers.slice(0, 3).join(', ')}${importers.length > 3 ? '...' : ''}`
          : `WARNING: ${file} is not imported by any other file`,
        durationMs: Date.now() - start,
      });
    } catch {
      results.push({
        name: `Wired: ${file}`,
        passed: false,
        output: `Could not check imports for ${file}`,
        durationMs: Date.now() - start,
      });
    }
  }

  return results;
}

// ============================================
// Public registration
// ============================================

export function registerVerifyTools(server: McpServer): void {
  server.tool(
    'verify',
    'Verify task completion at 4 levels. Level 1: files exist. Level 2: no TODO/placeholder stubs. Level 3: files are imported/wired. Level 4: typecheck + build + test. Default (no level): typecheck + build.',
    {
      level: z.number().int().min(1).max(4).optional()
        .describe('Verification level (1=exists, 2=substantive, 3=wired, 4=functional). Omit for legacy typecheck+build.'),
      files: z.array(z.string()).optional()
        .describe('Files to verify (required for levels 1-3). Relative to radl dir or absolute paths.'),
      checks: z.array(z.enum(['typecheck', 'build', 'test'])).optional()
        .describe('Which functional checks to run at level 4 (defaults to typecheck + build)'),
      intent: z.string().min(1).max(100).optional()
        .describe('Short intent description for structured logging (e.g., "pre-PR check")'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    withErrorTracking('verify', async ({ level, files, checks, intent }) => {
      if (intent) {
        logger.info('Verify intent', { intent, level, files, checks });
      }

      let results: CheckResult[] = [];

      if (level && level <= 3) {
        // Levels 1-3 require files
        if (!files || files.length === 0) {
          return { content: [{ type: 'text' as const, text: `Level ${level} verification requires a "files" parameter.` }] };
        }

        switch (level) {
          case 1:
            results = checkExists(files);
            break;
          case 2:
            results = [...checkExists(files), ...checkSubstantive(files)];
            break;
          case 3:
            results = [...checkExists(files), ...checkSubstantive(files), ...checkWired(files)];
            break;
        }
      } else {
        // Level 4 or default: functional checks
        const toRun = checks ?? ['typecheck', 'build'];

        // If level 4 with files, also run levels 1-3
        if (level === 4 && files && files.length > 0) {
          results = [...checkExists(files), ...checkSubstantive(files), ...checkWired(files)];
        }

        for (const check of toRun) {
          switch (check) {
            case 'typecheck':
              results.push(runCheck('TypeScript', 'npx tsc --noEmit'));
              break;
            case 'build':
              results.push(runCheck('Build', 'npm run build'));
              break;
            case 'test':
              results.push(runCheck('Tests', 'npm test'));
              break;
          }
        }
      }

      const allPassed = results.every(r => r.passed);
      const levelLabel = level ? `Level ${level}` : 'Default';
      const lines: string[] = [
        allPassed ? `${levelLabel} VERIFICATION PASSED` : `${levelLabel} VERIFICATION FAILED`,
        '',
      ];

      for (const r of results) {
        const icon = r.passed ? 'PASS' : 'FAIL';
        const duration = (r.durationMs / 1000).toFixed(1);
        lines.push(`[${icon}] ${r.name} (${duration}s)`);
        if (!r.passed) {
          lines.push('```');
          lines.push(r.output.trim());
          lines.push('```');
        }
        lines.push('');
      }

      logger.info('Verification complete', {
        level: level ?? 'default',
        allPassed,
        results: results.map(r => ({ name: r.name, passed: r.passed, durationMs: r.durationMs })),
      });

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    })
  );
}
