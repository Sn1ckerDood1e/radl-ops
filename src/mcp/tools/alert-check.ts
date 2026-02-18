/**
 * MCP Alert Check Tool - Critical alert detection and Gmail delivery
 *
 * Runs production health checks. If any service is in CRITICAL state,
 * sends an immediate Gmail alert. Tracks cooldowns to prevent spam.
 *
 * Designed to be called from cron (every 5 min) or ad-hoc.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { sendGmail, isGoogleConfigured } from '../../integrations/google.js';
import { config } from '../../config/index.js';
import { getConfig } from '../../config/paths.js';

interface AlertCooldown {
  alertId: string;
  lastSentAt: string;
  cooldownMinutes: number;
}

interface AlertState {
  cooldowns: AlertCooldown[];
}

function getAlertStatePath(): string {
  return `${getConfig().knowledgeDir}/alert-state.json`;
}

function loadAlertState(): AlertState {
  if (!existsSync(getAlertStatePath())) return { cooldowns: [] };
  try {
    return JSON.parse(readFileSync(getAlertStatePath(), 'utf-8')) as AlertState;
  } catch {
    return { cooldowns: [] };
  }
}

function saveAlertState(state: AlertState): void {
  const tmpPath = `${getAlertStatePath()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, getAlertStatePath());
}

function isInCooldown(state: AlertState, alertId: string, cooldownMinutes: number): boolean {
  const entry = state.cooldowns.find(c => c.alertId === alertId);
  if (!entry) return false;
  const elapsed = (Date.now() - new Date(entry.lastSentAt).getTime()) / (1000 * 60);
  return elapsed < cooldownMinutes;
}

function recordAlertSent(state: AlertState, alertId: string, cooldownMinutes: number): AlertState {
  const filtered = state.cooldowns.filter(c => c.alertId !== alertId);
  return {
    cooldowns: [
      ...filtered,
      { alertId, lastSentAt: new Date().toISOString(), cooldownMinutes },
    ],
  };
}

// ---------------------------------------------------------------------------
// Alert Rules
// ---------------------------------------------------------------------------

interface AlertRule {
  id: string;
  name: string;
  level: 'critical' | 'warning';
  cooldownMinutes: number;
  check: (status: ServiceCheckResult) => boolean;
  message: (status: ServiceCheckResult) => string;
}

interface ServiceCheckResult {
  service: string;
  status: 'ok' | 'warning' | 'error' | 'unavailable';
  summary: string;
  details: string[];
}

const ALERT_RULES: AlertRule[] = [
  {
    id: 'vercel_deploy_failed',
    name: 'Vercel Deploy Failed',
    level: 'critical',
    cooldownMinutes: 0, // Always alert
    check: (s) => s.service === 'vercel' && s.status === 'error',
    message: (s) => `Vercel deployment failure detected.\n\n${s.summary}\n\n${s.details.join('\n')}`,
  },
  {
    id: 'supabase_down',
    name: 'Supabase Down',
    level: 'critical',
    cooldownMinutes: 5,
    check: (s) => s.service === 'supabase' && s.status === 'error',
    message: (s) => `Supabase health check failed.\n\n${s.summary}\n\n${s.details.join('\n')}`,
  },
  {
    id: 'sentry_high_errors',
    name: 'Sentry High Error Count',
    level: 'critical',
    cooldownMinutes: 15,
    check: (s) => s.service === 'sentry' && s.status === 'error',
    message: (s) => `High error rate in Sentry.\n\n${s.summary}\n\n${s.details.join('\n')}`,
  },
  {
    id: 'sentry_new_issues',
    name: 'Sentry New Issues',
    level: 'warning',
    cooldownMinutes: 60,
    check: (s) => s.service === 'sentry' && s.status === 'warning',
    message: (s) => `New unresolved issues in Sentry.\n\n${s.summary}\n\n${s.details.join('\n')}`,
  },
];

// ---------------------------------------------------------------------------
// Service Checks (lightweight — reuses production-status logic patterns)
// ---------------------------------------------------------------------------

async function fetchJSON<T>(url: string, headers: Record<string, string>, timeoutMs = 10_000): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function checkServices(): Promise<ServiceCheckResult[]> {
  const results: ServiceCheckResult[] = [];

  // Vercel
  const { token: vToken, projectId: vProject } = config.vercel;
  if (vToken && vProject) {
    interface VDep { readyState: string; createdAt: number; meta?: { githubCommitMessage?: string } }
    const data = await fetchJSON<{ deployments: VDep[] }>(
      `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(vProject)}&limit=3&target=production`,
      { Authorization: `Bearer ${vToken}` },
    );
    if (data) {
      const latest = data.deployments?.[0];
      const FAILED_STATES = new Set(['ERROR', 'CANCELED']);
      const status = !latest ? 'warning'
        : latest.readyState === 'READY' ? 'ok'
        : FAILED_STATES.has(latest.readyState) ? 'error'
        : 'warning'; // BUILDING, QUEUED, INITIALIZING — not failures
      results.push({
        service: 'vercel',
        status,
        summary: latest ? `${latest.readyState}` : 'No deployments',
        details: latest ? [`Commit: ${latest.meta?.githubCommitMessage?.slice(0, 80) ?? 'unknown'}`] : [],
      });
    }
  }

  // Supabase
  const { projectId: sProject, accessToken: sToken } = config.supabase;
  if (sProject && sToken) {
    const project = await fetchJSON<{ status: string }>(
      `https://api.supabase.com/v1/projects/${encodeURIComponent(sProject)}`,
      { Authorization: `Bearer ${sToken}` },
    );
    results.push({
      service: 'supabase',
      status: project?.status === 'ACTIVE_HEALTHY' ? 'ok' : project ? 'warning' : 'error',
      summary: project?.status ?? 'Unreachable',
      details: [],
    });
  }

  // Sentry
  const { authToken: seToken, org: seOrg, project: seProject } = config.sentry;
  if (seToken && seOrg && seProject) {
    interface SIssue { level: string; title: string; count: string }
    const issues = await fetchJSON<SIssue[]>(
      `https://sentry.io/api/0/projects/${encodeURIComponent(seOrg)}/${encodeURIComponent(seProject)}/issues/?query=is:unresolved&statsPeriod=24h&sort=freq`,
      { Authorization: `Bearer ${seToken}` },
    );
    if (issues) {
      const errorCount = issues.filter(i => i.level === 'error').length;
      results.push({
        service: 'sentry',
        status: errorCount > 5 ? 'error' : errorCount > 0 ? 'warning' : 'ok',
        summary: `${issues.length} unresolved (${errorCount} errors)`,
        details: issues.slice(0, 3).map(i => `[${i.level}] ${i.title.slice(0, 60)} (${i.count}x)`),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Alert Email
// ---------------------------------------------------------------------------

function buildAlertHtml(rule: AlertRule, message: string): string {
  const icon = rule.level === 'critical' ? 'CRITICAL' : 'WARNING';
  const color = rule.level === 'critical' ? '#dc2626' : '#f59e0b';
  const time = new Date().toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1a1a1a;">
<div style="border-left:4px solid ${color};padding:16px;background:#fafafa;border-radius:4px;">
<h2 style="margin:0 0 8px;color:${color};">${icon}: ${rule.name}</h2>
<p style="color:#64748b;margin:0 0 16px;font-size:13px;">${time}</p>
<pre style="white-space:pre-wrap;font-family:inherit;margin:0;line-height:1.6;">${message}</pre>
</div>
<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0 8px;">
<p style="color:#94a3b8;font-size:12px;">Radl Ops Alert System | Cooldown: ${rule.cooldownMinutes}m</p>
</body></html>`;
}

// ---------------------------------------------------------------------------
// MCP Tool
// ---------------------------------------------------------------------------

export function registerAlertCheckTools(server: McpServer): void {
  server.tool(
    'alert_check',
    'Check production services for CRITICAL/WARNING conditions and send Gmail alerts. Respects cooldowns to prevent spam. Designed for cron (every 5 min) or ad-hoc use.',
    {
      dry_run: z.boolean().optional()
        .describe('Check services but do not send emails. Returns what would be sent.'),
      force: z.boolean().optional()
        .describe('Ignore cooldowns and send alerts even if recently sent.'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    withErrorTracking('alert_check', async ({ dry_run, force }) => {
      const results = await checkServices();

      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No services configured for monitoring.' }] };
      }

      let alertState = loadAlertState();
      const triggered: string[] = [];
      const skipped: string[] = [];
      const sent: string[] = [];

      for (const check of results) {
        for (const rule of ALERT_RULES) {
          if (!rule.check(check)) continue;
          triggered.push(`[${rule.level.toUpperCase()}] ${rule.name}: ${check.summary}`);

          if (!force && isInCooldown(alertState, rule.id, rule.cooldownMinutes)) {
            skipped.push(`${rule.name} (in cooldown)`);
            continue;
          }

          if (dry_run) {
            sent.push(`[DRY RUN] Would send: ${rule.name}`);
            continue;
          }

          if (!isGoogleConfigured()) {
            skipped.push(`${rule.name} (Google not configured)`);
            continue;
          }

          // Send alert email
          try {
            const to = config.google.briefingRecipient;
            const subjectIcon = rule.level === 'critical' ? 'CRITICAL' : 'WARNING';
            const subject = `[${subjectIcon}] Radl: ${rule.name}`;
            const message = rule.message(check);
            const htmlBody = buildAlertHtml(rule, message);

            await sendGmail({ to, subject, htmlBody });
            alertState = recordAlertSent(alertState, rule.id, rule.cooldownMinutes);
            sent.push(`${rule.name} → ${to}`);
            logger.info('Alert sent', { rule: rule.id, to });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            skipped.push(`${rule.name} (send failed: ${msg})`);
            logger.error('Alert send failed', { rule: rule.id, error: msg });
          }
        }
      }

      if (!dry_run) {
        saveAlertState(alertState);
      }

      // Format report
      const lines: string[] = [];
      const serviceStatuses = results.map(r => `[${r.status.toUpperCase()}] ${r.service}: ${r.summary}`);
      lines.push('**Service Status:**', ...serviceStatuses.map(s => `  ${s}`), '');

      if (triggered.length > 0) {
        lines.push('**Alerts Triggered:**', ...triggered.map(t => `  ${t}`), '');
      }
      if (sent.length > 0) {
        lines.push('**Alerts Sent:**', ...sent.map(s => `  ${s}`), '');
      }
      if (skipped.length > 0) {
        lines.push('**Skipped:**', ...skipped.map(s => `  ${s}`), '');
      }
      if (triggered.length === 0) {
        lines.push('All services healthy. No alerts triggered.');
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    })
  );
}
