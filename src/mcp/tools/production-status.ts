/**
 * MCP Production Status Tool - Comprehensive production health monitoring
 *
 * Aggregates data from Vercel (deployments), Supabase (DB health, auth logs),
 * Sentry (error counts), and GitHub (open issues) into a single status report.
 *
 * Uses API tokens directly (no MCP-to-MCP calls). Designed to be included
 * in morning briefings and called ad-hoc for troubleshooting.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../../config/index.js';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';

interface ServiceStatus {
  status: 'ok' | 'warning' | 'error' | 'unavailable';
  summary: string;
  details?: string[];
}

interface ProductionReport {
  overall: 'healthy' | 'degraded' | 'issues_detected';
  timestamp: string;
  services: Record<string, ServiceStatus>;
}

async function fetchJSON<T>(url: string, headers: Record<string, string>, timeoutMs = 10_000): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      logger.debug('fetchJSON non-OK response', { status: response.status, origin: new URL(url).origin });
      return null;
    }
    return (await response.json()) as T;
  } catch (err) {
    logger.debug('fetchJSON failed', { error: err instanceof Error ? err.message : 'unknown' });
    return null;
  }
}

async function checkVercelDeployments(): Promise<ServiceStatus> {
  const { token, projectId } = config.vercel;
  if (!token || !projectId) {
    return { status: 'unavailable', summary: 'Vercel token or project ID not configured' };
  }

  interface VercelDeployment {
    uid: string;
    state: string;
    readyState: string;
    createdAt: number;
    meta?: { githubCommitMessage?: string };
  }

  const data = await fetchJSON<{ deployments: VercelDeployment[] }>(
    `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=5&target=production`,
    { Authorization: `Bearer ${token}` },
  );

  if (!data) {
    return { status: 'error', summary: 'Failed to reach Vercel API' };
  }

  const deployments = data.deployments ?? [];
  if (deployments.length === 0) {
    return { status: 'warning', summary: 'No production deployments found' };
  }

  const latest = deployments[0];
  const hoursAgo = Math.round((Date.now() - latest.createdAt) / (1000 * 60 * 60));

  const failedRecent = deployments.filter(d => d.readyState === 'ERROR').length;
  const details: string[] = [
    `Latest: ${latest.readyState} (${hoursAgo}h ago)`,
    `Commit: ${latest.meta?.githubCommitMessage?.slice(0, 80) ?? 'unknown'}`,
  ];

  if (failedRecent > 0) {
    details.push(`${failedRecent} of last 5 deployments failed`);
  }

  const status = latest.readyState === 'READY'
    ? (failedRecent > 0 ? 'warning' : 'ok')
    : 'error';

  return {
    status,
    summary: `Latest deploy: ${latest.readyState} (${hoursAgo}h ago)${failedRecent > 0 ? `, ${failedRecent} recent failures` : ''}`,
    details,
  };
}

async function checkSupabaseHealth(): Promise<ServiceStatus> {
  const { projectId, accessToken } = config.supabase;
  if (!projectId || !accessToken) {
    return { status: 'unavailable', summary: 'Supabase project ID or access token not configured' };
  }

  // Check project health via Management API
  // NOTE: Do NOT add database.host or connection strings — output flows to Anthropic API via briefings
  interface SupabaseProject {
    status: string;
    name: string;
    region: string;
  }

  const project = await fetchJSON<SupabaseProject>(
    `https://api.supabase.com/v1/projects/${encodeURIComponent(projectId)}`,
    { Authorization: `Bearer ${accessToken}` },
  );

  if (!project) {
    return { status: 'error', summary: 'Failed to reach Supabase Management API' };
  }

  const details: string[] = [
    `Project: ${project.name}`,
    `Status: ${project.status}`,
    `Region: ${project.region}`,
  ];

  // Also check for recent auth errors via health endpoint
  const health = await fetchJSON<{ status: string }>(
    `https://api.supabase.com/v1/projects/${encodeURIComponent(projectId)}/health`,
    { Authorization: `Bearer ${accessToken}` },
  );

  if (health) {
    details.push(`Health: ${health.status ?? 'unknown'}`);
  }

  const status = project.status === 'ACTIVE_HEALTHY' ? 'ok' : 'warning';

  return {
    status,
    summary: `${project.status}${project.region ? ` (${project.region})` : ''}`,
    details,
  };
}

async function checkSentryErrors(): Promise<ServiceStatus> {
  const { authToken, org, project } = config.sentry;
  if (!authToken || !org || !project) {
    return { status: 'unavailable', summary: 'Sentry credentials not configured' };
  }

  interface SentryIssue {
    id: string;
    title: string;
    level: string;
    count: string;
    firstSeen: string;
    lastSeen: string;
  }

  const issues = await fetchJSON<SentryIssue[]>(
    `https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?query=is:unresolved&statsPeriod=24h&sort=freq`,
    { Authorization: `Bearer ${authToken}` },
  );

  if (!issues) {
    return { status: 'error', summary: 'Failed to reach Sentry API' };
  }

  if (issues.length === 0) {
    return { status: 'ok', summary: 'No unresolved errors in last 24h' };
  }

  const errorCount = issues.filter(i => i.level === 'error').length;
  const warningCount = issues.filter(i => i.level === 'warning').length;
  const details = issues.slice(0, 5).map(i =>
    `[${i.level}] ${i.title.slice(0, 80)} (${i.count}x)`
  );

  const status = errorCount > 5 ? 'error' : errorCount > 0 ? 'warning' : 'ok';

  return {
    status,
    summary: `${issues.length} unresolved issues (${errorCount} errors, ${warningCount} warnings)`,
    details,
  };
}

async function checkGitHubIssues(): Promise<ServiceStatus> {
  const { token, owner, repo } = config.github;
  if (!token) {
    return { status: 'unavailable', summary: 'GitHub token not configured' };
  }

  interface GitHubIssue {
    number: number;
    title: string;
    labels: Array<{ name: string }>;
    created_at: string;
  }

  const issues = await fetchJSON<GitHubIssue[]>(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=10&sort=created&direction=desc`,
    { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' },
  );

  if (!issues) {
    return { status: 'error', summary: 'Failed to reach GitHub API' };
  }

  // Filter out PRs (GitHub API returns both issues and PRs)
  const realIssues = issues.filter(i => !('pull_request' in i));

  if (realIssues.length === 0) {
    return { status: 'ok', summary: 'No open issues' };
  }

  const bugCount = realIssues.filter(i =>
    i.labels.some(l => l.name.toLowerCase().includes('bug'))
  ).length;

  const details = realIssues.slice(0, 5).map(i =>
    `#${i.number}: ${i.title.slice(0, 60)}`
  );

  const status = bugCount > 3 ? 'warning' : 'ok';

  return {
    status,
    summary: `${realIssues.length} open issues${bugCount > 0 ? ` (${bugCount} bugs)` : ''}`,
    details,
  };
}

function formatReport(report: ProductionReport): string {
  const icon = (s: ServiceStatus['status']): string => {
    switch (s) {
      case 'ok': return '[OK]';
      case 'warning': return '[WARN]';
      case 'error': return '[ERROR]';
      case 'unavailable': return '[N/A]';
    }
  };

  const overallIcon = report.overall === 'healthy' ? '[OK]'
    : report.overall === 'degraded' ? '[WARN]'
    : '[ERROR]';

  const lines: string[] = [
    `${overallIcon} Production Status — ${new Date(report.timestamp).toLocaleString()}`,
    '',
  ];

  for (const [name, svc] of Object.entries(report.services)) {
    lines.push(`${icon(svc.status)} **${name}**: ${svc.summary}`);
    if (svc.details && svc.details.length > 0) {
      for (const d of svc.details) {
        lines.push(`   ${d}`);
      }
    }
  }

  return lines.join('\n');
}

export function registerProductionStatusTools(server: McpServer): void {
  server.tool(
    'production_status',
    'Comprehensive production health check. Queries Vercel (deployments), Supabase (project health), Sentry (errors), GitHub (issues). One call, full picture. Include output in briefings.',
    {
      services: z.array(z.enum(['vercel', 'supabase', 'sentry', 'github'])).optional()
        .describe('Services to check (defaults to all configured)'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    withErrorTracking('production_status', async ({ services }) => {
      const toCheck = services ?? ['vercel', 'supabase', 'sentry', 'github'];
      const results: Record<string, ServiceStatus> = {};

      const checks = toCheck.map(async (svc) => {
        switch (svc) {
          case 'vercel': results.Vercel = await checkVercelDeployments(); break;
          case 'supabase': results.Supabase = await checkSupabaseHealth(); break;
          case 'sentry': results.Sentry = await checkSentryErrors(); break;
          case 'github': results.GitHub = await checkGitHubIssues(); break;
        }
      });
      await Promise.all(checks);

      const statuses = Object.values(results).map(r => r.status);
      const configured = statuses.filter(s => s !== 'unavailable');
      const hasError = configured.includes('error');
      const hasWarning = configured.includes('warning');
      const overall: ProductionReport['overall'] = configured.length === 0 ? 'degraded'
        : hasError ? 'issues_detected'
        : hasWarning ? 'degraded'
        : 'healthy';

      const report: ProductionReport = {
        overall,
        timestamp: new Date().toISOString(),
        services: results,
      };

      logger.info('Production status check completed', {
        overall,
        services: Object.fromEntries(
          Object.entries(results).map(([k, v]) => [k, v.status])
        ),
      });

      return {
        content: [{ type: 'text' as const, text: formatReport(report) }],
        structuredContent: report,
      };
    })
  );
}
