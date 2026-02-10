/**
 * MCP Verification Tool - Pre-PR checks
 *
 * Runs typecheck, build, and tests against the Radl codebase.
 * Returns pass/fail with error details for each check.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execSync } from 'child_process';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';

const RADL_DIR = '/home/hb/radl';

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
      cwd: RADL_DIR,
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

export function registerVerifyTools(server: McpServer): void {
  server.tool(
    'verify',
    'Run pre-PR verification checks on the Radl codebase: typecheck, build, and optionally tests. Returns pass/fail with error details.',
    {
      checks: z.array(z.enum(['typecheck', 'build', 'test'])).optional()
        .describe('Which checks to run (defaults to typecheck + build)'),
    },
    withErrorTracking('verify', async ({ checks }) => {
      const toRun = checks ?? ['typecheck', 'build'];
      const results: CheckResult[] = [];

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

      const allPassed = results.every(r => r.passed);
      const lines: string[] = [
        allPassed ? 'ALL CHECKS PASSED' : 'CHECKS FAILED',
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
        checks: toRun,
        allPassed,
        results: results.map(r => ({ name: r.name, passed: r.passed, durationMs: r.durationMs })),
      });

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    })
  );
}
