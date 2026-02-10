/**
 * MCP Monitoring Tools - Service health checks
 *
 * Aggregated health check across Vercel, Supabase, GitHub in one call.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../../config/index.js';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';

interface HealthResult {
  status: 'healthy' | 'degraded' | 'down';
  message: string;
  checkedAt: string;
}

async function checkVercel(): Promise<HealthResult> {
  try {
    const response = await fetch('https://radl.app', {
      method: 'HEAD',
      signal: AbortSignal.timeout(10000),
    });
    return {
      status: response.ok ? 'healthy' : 'degraded',
      message: response.ok
        ? `Vercel responding (${response.status})`
        : `Vercel returned ${response.status}`,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return {
      status: 'down',
      message: 'Vercel not responding (timeout or network error)',
      checkedAt: new Date().toISOString(),
    };
  }
}

async function checkSupabase(): Promise<HealthResult> {
  const supabaseUrl = config.supabase?.url;
  if (!supabaseUrl) {
    return {
      status: 'degraded',
      message: 'Supabase URL not configured',
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/`, {
      method: 'HEAD',
      headers: { apikey: config.supabase?.anonKey || '' },
      signal: AbortSignal.timeout(10000),
    });
    return {
      status: response.ok || response.status === 401 ? 'healthy' : 'degraded',
      message: `Supabase API responding (${response.status})`,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return {
      status: 'down',
      message: 'Supabase not responding',
      checkedAt: new Date().toISOString(),
    };
  }
}

async function checkGitHub(): Promise<HealthResult> {
  try {
    const headers: Record<string, string> = {};
    if (config.github.token) {
      headers.Authorization = `Bearer ${config.github.token}`;
    }
    const response = await fetch('https://api.github.com/rate_limit', {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        rate: { remaining: number; limit: number };
      };
      const remaining = data.rate?.remaining ?? 0;
      const limit = data.rate?.limit ?? 0;
      return {
        status: remaining > 100 ? 'healthy' : remaining > 0 ? 'degraded' : 'down',
        message: `GitHub API: ${remaining}/${limit} requests remaining`,
        checkedAt: new Date().toISOString(),
      };
    }
    return {
      status: 'degraded',
      message: `GitHub API returned ${response.status}`,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return {
      status: 'down',
      message: 'GitHub API not responding',
      checkedAt: new Date().toISOString(),
    };
  }
}

export function registerMonitoringTools(server: McpServer): void {
  server.tool(
    'health_check',
    'Check health status of Vercel, Supabase, and GitHub for Radl. One call checks all services.',
    { services: z.array(z.enum(['vercel', 'supabase', 'github'])).optional().describe('Services to check (defaults to all)') },
    withErrorTracking('health_check', async ({ services }) => {
      const toCheck = services ?? ['vercel', 'supabase', 'github'];
      const results: Record<string, HealthResult> = {};

      const checks = toCheck.map(async (svc) => {
        switch (svc) {
          case 'vercel': results.vercel = await checkVercel(); break;
          case 'supabase': results.supabase = await checkSupabase(); break;
          case 'github': results.github = await checkGitHub(); break;
        }
      });
      await Promise.all(checks);

      const allHealthy = Object.values(results).every(r => r.status === 'healthy');
      const anyDown = Object.values(results).some(r => r.status === 'down');
      const overall = anyDown ? 'issues_detected' : allHealthy ? 'all_healthy' : 'degraded';

      logger.info('MCP health check completed', { overall });

      const lines = [`Overall: ${overall}`, ''];
      for (const [name, result] of Object.entries(results)) {
        const icon = result.status === 'healthy' ? '[OK]' : result.status === 'degraded' ? '[WARN]' : '[DOWN]';
        lines.push(`${icon} ${name}: ${result.message}`);
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    })
  );
}
