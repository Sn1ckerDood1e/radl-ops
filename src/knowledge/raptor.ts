/**
 * RAPTOR-Style Hierarchical Knowledge Summaries
 *
 * Periodically clusters related knowledge entries and generates
 * multi-level summaries using Haiku:
 *
 * - Level 0: Raw knowledge entries (patterns, lessons, decisions)
 * - Level 1: Cluster summaries grouped by topic similarity
 * - Level 2: Domain-level overviews (security, database, workflow, etc.)
 *
 * Stored in knowledge/raptor-summaries.json for use by inverse_bloom
 * when no specific match is found (provides high-level context instead).
 *
 * Cost: ~$0.005 per full rebuild (Haiku for all cluster summaries).
 */

import type Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../config/paths.js';
import { getAnthropicClient } from '../config/anthropic.js';
import { getRoute, calculateCost } from '../models/router.js';
import { trackUsage } from '../models/token-tracker.js';
import { searchFts, isFtsAvailable } from './fts-index.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../config/logger.js';

// ============================================
// Types
// ============================================

export interface RaptorCluster {
  id: string;
  label: string;
  domain: string;
  entryCount: number;
  entries: Array<{ id: string; text: string }>;
  summary: string;
}

export interface RaptorDomain {
  name: string;
  clusterCount: number;
  entryCount: number;
  overview: string;
}

export interface RaptorSummaries {
  generatedAt: string;
  totalEntries: number;
  totalClusters: number;
  costUsd: number;
  clusters: RaptorCluster[];
  domains: RaptorDomain[];
}

// ============================================
// Predefined Domains (keyword-based clustering)
// ============================================

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  security: ['csrf', 'auth', 'secret', 'injection', 'xss', 'permission', 'token', 'cookie', 'getuser', 'getsession', 'rls', 'rbac'],
  database: ['prisma', 'migration', 'enum', 'schema', 'postgresql', 'supabase', 'query', 'index', 'nullable', 'backfill', 'foreign key'],
  workflow: ['sprint', 'branch', 'commit', 'pr', 'review', 'feature', 'compound', 'blocker', 'checkpoint', 'estimate'],
  architecture: ['evaluator', 'optimizer', 'bloom', 'pipeline', 'dispatcher', 'routing', 'model', 'mcp', 'conductor', 'antibody', 'crystallize'],
  frontend: ['component', 'react', 'client', 'server', 'props', 'render', 'form', 'toast', 'tailwind', 'css', 'shadcn', 'dark mode'],
  testing: ['test', 'coverage', 'vitest', 'playwright', 'mock', 'tdd', 'e2e', 'assertion'],
  agent: ['agent', 'team', 'parallel', 'file ownership', 'sub-agent', 'watcher', 'autonomous'],
};

// ============================================
// File I/O
// ============================================

function getSummariesPath(): string {
  return join(getConfig().knowledgeDir, 'raptor-summaries.json');
}

function loadSummaries(): RaptorSummaries | null {
  const path = getSummariesPath();
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as RaptorSummaries;
  } catch {
    return null;
  }
}

function saveSummaries(summaries: RaptorSummaries): void {
  writeFileSync(getSummariesPath(), JSON.stringify(summaries, null, 2));
}

// ============================================
// Clustering
// ============================================

interface RawEntry {
  id: string;
  text: string;
}

function classifyEntry(entry: RawEntry): string {
  const lower = entry.text.toLowerCase();
  let bestDomain = 'general';
  let bestScore = 0;

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const score = keywords.filter(kw => lower.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestDomain = domain;
    }
  }

  return bestDomain;
}

function clusterEntries(entries: RawEntry[]): Map<string, RawEntry[]> {
  const clusters = new Map<string, RawEntry[]>();

  for (const entry of entries) {
    const domain = classifyEntry(entry);
    const existing = clusters.get(domain) ?? [];
    clusters.set(domain, [...existing, entry]);
  }

  return clusters;
}

// ============================================
// Summary Generation
// ============================================

async function summarizeCluster(
  domain: string,
  entries: RawEntry[],
): Promise<{ summary: string; costUsd: number }> {
  // Truncate entries to fit in Haiku context
  const entrySummaries = entries
    .slice(0, 20)
    .map((e, i) => `${i + 1}. ${e.text.substring(0, 200)}`)
    .join('\n');

  const prompt = `Summarize these ${entries.length} knowledge base entries in the "${domain}" domain into a concise 2-3 sentence overview. Focus on the key patterns, rules, and lessons. Be specific, not generic.

Entries:
${entrySummaries}

Write a concise summary paragraph (2-3 sentences).`;

  const route = getRoute('spot_check');

  const response = await withRetry(
    () => getAnthropicClient().messages.create({
      model: route.model,
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    }),
    { maxRetries: 2, baseDelayMs: 1000 },
  );

  const costUsd = calculateCost(
    route.model,
    response.usage.input_tokens,
    response.usage.output_tokens,
  );

  trackUsage(
    route.model,
    response.usage.input_tokens,
    response.usage.output_tokens,
    'spot_check',
    'raptor-cluster',
  );

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  return { summary: text, costUsd };
}

async function generateDomainOverview(
  domain: string,
  clusters: RaptorCluster[],
): Promise<{ overview: string; costUsd: number }> {
  const clusterSummaries = clusters
    .map(c => `- ${c.label} (${c.entryCount} entries): ${c.summary}`)
    .join('\n');

  const prompt = `Write a 1-2 sentence high-level overview of the "${domain}" domain based on these cluster summaries:

${clusterSummaries}

Be specific about the most important patterns and rules in this domain.`;

  const route = getRoute('spot_check');

  const response = await withRetry(
    () => getAnthropicClient().messages.create({
      model: route.model,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
    { maxRetries: 2, baseDelayMs: 1000 },
  );

  const costUsd = calculateCost(
    route.model,
    response.usage.input_tokens,
    response.usage.output_tokens,
  );

  trackUsage(
    route.model,
    response.usage.input_tokens,
    response.usage.output_tokens,
    'spot_check',
    'raptor-domain',
  );

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  return { overview: text, costUsd };
}

// ============================================
// Public API
// ============================================

/**
 * Rebuild RAPTOR summaries from the knowledge base.
 * Clusters entries by domain, generates summaries via Haiku.
 * Cost: ~$0.005 for a typical knowledge base.
 */
export async function buildRaptorSummaries(): Promise<RaptorSummaries> {
  if (!isFtsAvailable()) {
    return {
      generatedAt: new Date().toISOString(),
      totalEntries: 0,
      totalClusters: 0,
      costUsd: 0,
      clusters: [],
      domains: [],
    };
  }

  // Gather all entries via a broad search
  const allDomains = Object.keys(DOMAIN_KEYWORDS);
  const seenIds = new Set<string>();
  const allEntries: RawEntry[] = [];

  // Search each domain to gather representative entries
  for (const domain of allDomains) {
    const keywords = DOMAIN_KEYWORDS[domain];
    const query = keywords.slice(0, 5).join(' ');
    const results = searchFts({ query, maxResults: 50 });

    for (const r of results) {
      if (!seenIds.has(r.id)) {
        seenIds.add(r.id);
        allEntries.push({ id: r.id, text: r.text });
      }
    }
  }

  // Also do a catch-all search for uncategorized entries
  const catchAll = searchFts({ query: 'pattern lesson decision', maxResults: 50 });
  for (const r of catchAll) {
    if (!seenIds.has(r.id)) {
      seenIds.add(r.id);
      allEntries.push({ id: r.id, text: r.text });
    }
  }

  // Cluster by domain
  const domainClusters = clusterEntries(allEntries);

  let totalCost = 0;
  const clusters: RaptorCluster[] = [];

  // Generate cluster summaries
  for (const [domain, entries] of domainClusters) {
    if (entries.length === 0) continue;

    const { summary, costUsd } = await summarizeCluster(domain, entries);
    totalCost += costUsd;

    clusters.push({
      id: `cluster-${domain}`,
      label: domain.charAt(0).toUpperCase() + domain.slice(1),
      domain,
      entryCount: entries.length,
      entries: entries.map(e => ({ id: e.id, text: e.text.substring(0, 150) })),
      summary,
    });
  }

  // Generate domain overviews
  const domainMap = new Map<string, RaptorCluster[]>();
  for (const cluster of clusters) {
    const existing = domainMap.get(cluster.domain) ?? [];
    domainMap.set(cluster.domain, [...existing, cluster]);
  }

  const domains: RaptorDomain[] = [];
  for (const [name, domClusters] of domainMap) {
    const { overview, costUsd } = await generateDomainOverview(name, domClusters);
    totalCost += costUsd;

    domains.push({
      name,
      clusterCount: domClusters.length,
      entryCount: domClusters.reduce((s, c) => s + c.entryCount, 0),
      overview,
    });
  }

  const summaries: RaptorSummaries = {
    generatedAt: new Date().toISOString(),
    totalEntries: allEntries.length,
    totalClusters: clusters.length,
    costUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
    clusters,
    domains,
  };

  saveSummaries(summaries);

  logger.info('RAPTOR summaries built', {
    entries: allEntries.length,
    clusters: clusters.length,
    domains: domains.length,
    costUsd: summaries.costUsd,
  });

  return summaries;
}

/**
 * Get cached RAPTOR summaries without rebuilding.
 */
export function getRaptorSummaries(): RaptorSummaries | null {
  return loadSummaries();
}

/**
 * Check if summaries are stale (older than the specified days).
 */
export function isSummaryStale(maxAgeDays: number = 7): boolean {
  const summaries = loadSummaries();
  if (!summaries) return true;

  const age = Date.now() - new Date(summaries.generatedAt).getTime();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  return age > maxAgeMs;
}

/**
 * Get a domain overview by name.
 * Used by inverse_bloom for high-level context injection.
 */
export function getDomainOverview(domain: string): string | null {
  const summaries = loadSummaries();
  if (!summaries) return null;

  const found = summaries.domains.find(d => d.name === domain);
  return found?.overview ?? null;
}

/**
 * Format RAPTOR summaries for display.
 */
export function formatRaptorReport(summaries: RaptorSummaries): string {
  const lines = [
    '## RAPTOR Knowledge Summaries',
    '',
    `**Generated:** ${summaries.generatedAt.split('T')[0]}`,
    `**Entries:** ${summaries.totalEntries}`,
    `**Clusters:** ${summaries.totalClusters}`,
    `**Cost:** $${summaries.costUsd.toFixed(4)}`,
    '',
    '### Domain Overviews',
  ];

  for (const domain of summaries.domains.sort((a, b) => b.entryCount - a.entryCount)) {
    lines.push(
      ``,
      `**${domain.name}** (${domain.entryCount} entries)`,
      domain.overview,
    );
  }

  lines.push('', '### Cluster Details');

  for (const cluster of summaries.clusters.sort((a, b) => b.entryCount - a.entryCount)) {
    lines.push(
      ``,
      `**${cluster.label}** (${cluster.entryCount} entries)`,
      cluster.summary,
    );
  }

  return lines.join('\n');
}
