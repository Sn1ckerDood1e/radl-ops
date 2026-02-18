#!/usr/bin/env npx tsx
/**
 * Alert Polling Script — standalone, no MCP server required.
 *
 * Checks Vercel, Supabase, and Sentry APIs for CRITICAL conditions.
 * Sends Gmail alerts with cooldown tracking.
 * Designed for cron: */5 * * * * (every 5 minutes).
 *
 * Usage: npx tsx /home/hb/radl-ops/scripts/alert-poll.ts
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Load .env
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '../.env') });

// Import Google API client (reuses the same credentials as MCP)
import { sendGmail, isGoogleConfigured } from '../src/integrations/google.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RECIPIENT = process.env.GOOGLE_BRIEFING_RECIPIENT ?? 'kinseymi@radl.solutions';
const KNOWLEDGE_DIR = process.env.RADL_KNOWLEDGE_DIR ?? join(__dirname, '../knowledge');
const ALERT_STATE_PATH = join(KNOWLEDGE_DIR, 'alert-state.json');

interface AlertCooldown {
  alertId: string;
  lastSentAt: string;
  cooldownMinutes: number;
}

interface AlertState {
  cooldowns: AlertCooldown[];
}

function loadState(): AlertState {
  if (!existsSync(ALERT_STATE_PATH)) return { cooldowns: [] };
  try {
    return JSON.parse(readFileSync(ALERT_STATE_PATH, 'utf-8'));
  } catch {
    return { cooldowns: [] };
  }
}

function saveState(state: AlertState): void {
  if (!existsSync(KNOWLEDGE_DIR)) mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  writeFileSync(ALERT_STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function isInCooldown(state: AlertState, alertId: string, cooldownMin: number): boolean {
  const entry = state.cooldowns.find(c => c.alertId === alertId);
  if (!entry) return false;
  return (Date.now() - new Date(entry.lastSentAt).getTime()) / 60_000 < cooldownMin;
}

function recordSent(state: AlertState, alertId: string, cooldownMin: number): AlertState {
  return {
    cooldowns: [
      ...state.cooldowns.filter(c => c.alertId !== alertId),
      { alertId, lastSentAt: new Date().toISOString(), cooldownMinutes: cooldownMin },
    ],
  };
}

// ---------------------------------------------------------------------------
// Service Checks
// ---------------------------------------------------------------------------

async function fetchJSON<T>(url: string, headers: Record<string, string>): Promise<T | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface Alert {
  id: string;
  name: string;
  level: 'critical' | 'warning';
  cooldownMin: number;
  message: string;
}

async function checkAll(): Promise<Alert[]> {
  const alerts: Alert[] = [];

  // Vercel
  const vToken = process.env.VERCEL_TOKEN;
  const vProject = process.env.VERCEL_PROJECT_ID;
  if (vToken && vProject) {
    interface VDep { readyState: string; meta?: { githubCommitMessage?: string } }
    const data = await fetchJSON<{ deployments: VDep[] }>(
      `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(vProject)}&limit=3&target=production`,
      { Authorization: `Bearer ${vToken}` },
    );
    const latest = data?.deployments?.[0];
    if (latest && latest.readyState !== 'READY') {
      alerts.push({
        id: 'vercel_deploy_failed',
        name: 'Vercel Deploy Failed',
        level: 'critical',
        cooldownMin: 0,
        message: `Deploy state: ${latest.readyState}\nCommit: ${latest.meta?.githubCommitMessage?.slice(0, 80) ?? 'unknown'}`,
      });
    }
  }

  // Supabase
  const sProject = process.env.SUPABASE_PROJECT_ID;
  const sToken = process.env.SUPABASE_ACCESS_TOKEN;
  if (sProject && sToken) {
    const project = await fetchJSON<{ status: string }>(
      `https://api.supabase.com/v1/projects/${encodeURIComponent(sProject)}`,
      { Authorization: `Bearer ${sToken}` },
    );
    if (!project) {
      alerts.push({
        id: 'supabase_unreachable',
        name: 'Supabase Unreachable',
        level: 'critical',
        cooldownMin: 5,
        message: 'Supabase Management API did not respond.',
      });
    } else if (project.status !== 'ACTIVE_HEALTHY') {
      alerts.push({
        id: 'supabase_unhealthy',
        name: 'Supabase Unhealthy',
        level: 'critical',
        cooldownMin: 5,
        message: `Status: ${project.status}`,
      });
    }
  }

  // Sentry
  const seToken = process.env.SENTRY_AUTH_TOKEN;
  const seOrg = process.env.SENTRY_ORG;
  const seProject = process.env.SENTRY_PROJECT;
  if (seToken && seOrg && seProject) {
    interface SIssue { level: string; title: string; count: string }
    const issues = await fetchJSON<SIssue[]>(
      `https://sentry.io/api/0/projects/${encodeURIComponent(seOrg)}/${encodeURIComponent(seProject)}/issues/?query=is:unresolved&statsPeriod=1h&sort=freq`,
      { Authorization: `Bearer ${seToken}` },
    );
    if (issues) {
      const errors = issues.filter(i => i.level === 'error');
      if (errors.length > 5) {
        alerts.push({
          id: 'sentry_high_errors',
          name: 'Sentry High Error Count',
          level: 'critical',
          cooldownMin: 15,
          message: `${errors.length} error-level issues in last hour:\n${errors.slice(0, 3).map(i => `- ${i.title.slice(0, 60)} (${i.count}x)`).join('\n')}`,
        });
      }
    }
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const alerts = await checkAll();

  if (alerts.length === 0) {
    // Silent exit — healthy
    process.exit(0);
  }

  if (!isGoogleConfigured()) {
    console.error('Alerts triggered but Google credentials not configured.');
    for (const a of alerts) console.error(`  [${a.level}] ${a.name}: ${a.message}`);
    process.exit(1);
  }

  let state = loadState();
  let sentCount = 0;

  for (const alert of alerts) {
    if (isInCooldown(state, alert.id, alert.cooldownMin)) {
      continue;
    }

    const time = new Date().toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });
    const color = alert.level === 'critical' ? '#dc2626' : '#f59e0b';

    const htmlBody = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
<div style="border-left:4px solid ${color};padding:16px;background:#fafafa;border-radius:4px;">
<h2 style="margin:0 0 8px;color:${color};">${alert.level.toUpperCase()}: ${alert.name}</h2>
<p style="color:#64748b;margin:0 0 16px;font-size:13px;">${time}</p>
<pre style="white-space:pre-wrap;font-family:inherit;margin:0;line-height:1.6;">${alert.message}</pre>
</div>
<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0 8px;">
<p style="color:#94a3b8;font-size:12px;">Radl Ops Alert System</p>
</body></html>`;

    try {
      await sendGmail({
        to: RECIPIENT,
        subject: `[${alert.level.toUpperCase()}] Radl: ${alert.name}`,
        htmlBody,
      });
      state = recordSent(state, alert.id, alert.cooldownMin);
      sentCount++;
      console.log(`Alert sent: ${alert.name}`);
    } catch (error) {
      console.error(`Failed to send alert ${alert.name}:`, error);
    }
  }

  saveState(state);
  if (sentCount > 0) {
    console.log(`${sentCount} alert(s) sent.`);
  }
}

main().catch(err => {
  console.error('Alert poll failed:', err);
  process.exit(1);
});
