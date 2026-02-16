/**
 * MCP Quality Ratchet Tool
 *
 * Maintains a trust ledger that records human decisions about AI
 * recommendations across domains (code-review, security-review,
 * estimation, decomposition). Tracks success rates, override rates,
 * and trust levels per domain. Also monitors false positive rates
 * from antibodies and crystallized checks.
 *
 * Two tools:
 * - trust_report: Zero-cost analytics per domain with false positive monitoring
 * - trust_record: Record a decision outcome for trust tracking
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../../config/logger.js';
import { getConfig } from '../../config/paths.js';

// ============================================
// Types
// ============================================

export interface TrustDecision {
  id: number;
  domain: string;
  decision: string;
  aiRecommended: string;
  humanOverride: boolean;
  outcome: 'success' | 'failure' | 'partial';
  sprint: string;
  recordedAt: string;
}

export interface TrustLedger {
  decisions: TrustDecision[];
}

interface DomainStats {
  domain: string;
  total: number;
  successes: number;
  failures: number;
  partials: number;
  successRate: number;
  overrides: number;
  overrideRate: number;
  trustLevel: 'high' | 'medium' | 'low';
}

interface FalsePositiveEntry {
  source: string;
  id: number;
  label: string;
  rate: number;
}

// ============================================
// Constants
// ============================================

const TRUST_LEDGER_FILE = 'trust-ledger.json';
const ANTIBODIES_FILE = 'antibodies.json';
const CRYSTALLIZED_FILE = 'crystallized.json';

const HIGH_TRUST_THRESHOLD = 0.8;
const MEDIUM_TRUST_THRESHOLD = 0.6;
const FALSE_POSITIVE_THRESHOLD = 0.3;

// ============================================
// File I/O
// ============================================

function getTrustLedgerPath(): string {
  return join(getConfig().knowledgeDir, TRUST_LEDGER_FILE);
}

export function loadTrustLedger(): TrustLedger {
  const filePath = getTrustLedgerPath();

  if (!existsSync(filePath)) {
    return { decisions: [] };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as TrustLedger;
    if (!Array.isArray(parsed.decisions)) {
      return { decisions: [] };
    }
    return parsed;
  } catch (error) {
    logger.warn('Failed to parse trust-ledger.json, returning empty ledger', {
      error: String(error),
    });
    return { decisions: [] };
  }
}

export function saveTrustLedger(ledger: TrustLedger): void {
  const filePath = getTrustLedgerPath();
  const dir = getConfig().knowledgeDir;

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(filePath, JSON.stringify(ledger, null, 2));
}

function loadAntibodiesFile(): Array<Record<string, unknown>> {
  const filePath = join(getConfig().knowledgeDir, ANTIBODIES_FILE);

  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as { antibodies?: unknown[] };
    return Array.isArray(parsed.antibodies)
      ? parsed.antibodies as Array<Record<string, unknown>>
      : [];
  } catch {
    return [];
  }
}

function loadCrystallizedFile(): Array<Record<string, unknown>> {
  const filePath = join(getConfig().knowledgeDir, CRYSTALLIZED_FILE);

  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as { checks?: unknown[] };
    return Array.isArray(parsed.checks)
      ? parsed.checks as Array<Record<string, unknown>>
      : [];
  } catch {
    return [];
  }
}

// ============================================
// Core Logic
// ============================================

function calculateDomainStats(decisions: TrustDecision[], domain: string): DomainStats {
  const domainDecisions = decisions.filter(d => d.domain === domain);
  const total = domainDecisions.length;

  if (total === 0) {
    return {
      domain,
      total: 0,
      successes: 0,
      failures: 0,
      partials: 0,
      successRate: 0,
      overrides: 0,
      overrideRate: 0,
      trustLevel: 'low',
    };
  }

  const successes = domainDecisions.filter(d => d.outcome === 'success').length;
  const failures = domainDecisions.filter(d => d.outcome === 'failure').length;
  const partials = domainDecisions.filter(d => d.outcome === 'partial').length;
  const overrides = domainDecisions.filter(d => d.humanOverride).length;

  const successRate = successes / total;
  const overrideRate = overrides / total;

  let trustLevel: 'high' | 'medium' | 'low';
  if (successRate >= HIGH_TRUST_THRESHOLD) {
    trustLevel = 'high';
  } else if (successRate >= MEDIUM_TRUST_THRESHOLD) {
    trustLevel = 'medium';
  } else {
    trustLevel = 'low';
  }

  return {
    domain,
    total,
    successes,
    failures,
    partials,
    successRate,
    overrides,
    overrideRate,
    trustLevel,
  };
}

/**
 * Check false positive rates across antibodies and crystallized checks.
 * Returns entries where the false positive rate exceeds the threshold (0.3).
 */
export function checkFalsePositiveRates(
  antibodies: Array<Record<string, unknown>>,
  crystallizedChecks: Array<Record<string, unknown>>,
): FalsePositiveEntry[] {
  const flagged: FalsePositiveEntry[] = [];

  for (const ab of antibodies) {
    const rate = Number(ab.falsePositiveRate ?? 0);
    if (rate > FALSE_POSITIVE_THRESHOLD) {
      flagged.push({
        source: 'antibody',
        id: Number(ab.id ?? 0),
        label: String(ab.trigger ?? 'unknown'),
        rate,
      });
    }
  }

  for (const check of crystallizedChecks) {
    const catches = Number(check.catches ?? 0);
    const falsePositives = Number(check.falsePositives ?? 0);
    const totalChecked = catches + falsePositives;

    if (totalChecked > 0) {
      const rate = falsePositives / totalChecked;
      if (rate > FALSE_POSITIVE_THRESHOLD) {
        flagged.push({
          source: 'crystallized',
          id: Number(check.id ?? 0),
          label: String(check.trigger ?? 'unknown'),
          rate,
        });
      }
    }
  }

  return flagged;
}

function getAllDomains(decisions: TrustDecision[]): string[] {
  const domainSet = new Set<string>();
  for (const d of decisions) {
    domainSet.add(d.domain);
  }
  return Array.from(domainSet).sort();
}

// ============================================
// Formatting
// ============================================

function formatTrustLevel(level: 'high' | 'medium' | 'low'): string {
  switch (level) {
    case 'high': return 'HIGH';
    case 'medium': return 'MEDIUM';
    case 'low': return 'LOW';
  }
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

function formatTrustReport(
  stats: DomainStats[],
  falsePositives: FalsePositiveEntry[],
  filterDomain?: string,
): string {
  const lines: string[] = [];

  const totalDecisions = stats.reduce((sum, s) => sum + s.total, 0);

  if (stats.length === 0 || totalDecisions === 0) {
    lines.push('# Trust Report');
    lines.push('');
    if (filterDomain) {
      lines.push(`No decisions recorded for domain "${filterDomain}". Use \`trust_record\` to add entries.`);
    } else {
      lines.push('No decisions recorded yet. Use `trust_record` to start tracking outcomes.');
    }
    return lines.join('\n');
  }

  lines.push('# Trust Report');
  lines.push('');

  if (filterDomain) {
    lines.push(`_Filtered to domain: ${filterDomain}_`);
    lines.push('');
  }

  lines.push(`**Total decisions:** ${totalDecisions} across ${stats.length} domain(s)`);
  lines.push('');

  // Summary table
  lines.push('| Domain | Decisions | Success Rate | Override Rate | Trust Level |');
  lines.push('|--------|-----------|-------------|--------------|-------------|');

  for (const s of stats) {
    lines.push(
      `| ${s.domain} | ${s.total} | ${formatPercent(s.successRate)} | ${formatPercent(s.overrideRate)} | ${formatTrustLevel(s.trustLevel)} |`,
    );
  }

  lines.push('');

  // Detail section per domain
  lines.push('## Domain Details');
  lines.push('');

  for (const s of stats) {
    lines.push(`### ${s.domain}`);
    lines.push('');
    lines.push(`- **Total decisions:** ${s.total}`);
    lines.push(`- **Successes:** ${s.successes} (${formatPercent(s.successRate)})`);
    lines.push(`- **Failures:** ${s.failures}`);
    lines.push(`- **Partial:** ${s.partials}`);
    lines.push(`- **Human overrides:** ${s.overrides} (${formatPercent(s.overrideRate)})`);
    lines.push(`- **Trust level:** ${formatTrustLevel(s.trustLevel)}`);
    lines.push('');
  }

  // False positive section
  if (falsePositives.length > 0) {
    lines.push('## False Positive Alerts');
    lines.push('');
    lines.push('The following checks have a false positive rate above 30%:');
    lines.push('');
    lines.push('| Source | ID | Label | FP Rate |');
    lines.push('|--------|----|-------|---------|');

    for (const fp of falsePositives) {
      const labelShort = fp.label.length > 50
        ? fp.label.substring(0, 47) + '...'
        : fp.label;
      lines.push(
        `| ${fp.source} | ${fp.id} | ${labelShort} | ${formatPercent(fp.rate)} |`,
      );
    }

    lines.push('');
    lines.push('Consider disabling or demoting these checks to reduce noise.');
  } else {
    lines.push('## False Positive Rates');
    lines.push('');
    lines.push('All antibodies and crystallized checks are within acceptable false positive thresholds (< 30%).');
  }

  return lines.join('\n');
}

// ============================================
// MCP Registration
// ============================================

export function registerQualityRatchetTools(server: McpServer): void {

  // --- trust_report ---
  server.tool(
    'trust_report',
    'Zero-cost trust analytics per domain. Shows success rates, override rates, trust levels, and false positive alerts from antibodies and crystallized checks.',
    {
      domain: z.string().max(100).optional()
        .describe('Filter to a specific domain (e.g., "code-review", "security-review", "estimation"). Omit to show all domains.'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async ({ domain }) => {
      const ledger = loadTrustLedger();

      logger.info('Generating trust report', {
        totalDecisions: ledger.decisions.length,
        filterDomain: domain ?? 'all',
      });

      // Determine which domains to report on
      const domains = domain
        ? [domain]
        : getAllDomains(ledger.decisions);

      const stats = domains.map(d => calculateDomainStats(ledger.decisions, d));

      // Load antibodies and crystallized checks for false positive analysis
      const antibodies = loadAntibodiesFile();
      const crystallizedChecks = loadCrystallizedFile();
      const allFalsePositives = checkFalsePositiveRates(antibodies, crystallizedChecks);

      const output = formatTrustReport(stats, allFalsePositives, domain);

      return {
        content: [{ type: 'text' as const, text: output }],
      };
    },
  );

  // --- trust_record ---
  server.tool(
    'trust_record',
    'Record a decision outcome for trust tracking. Captures what the AI recommended, whether the human overrode it, and the final outcome.',
    {
      domain: z.string().min(1).max(100)
        .describe('Domain of the decision (e.g., "code-review", "security-review", "estimation", "decomposition")'),
      decision: z.string().min(1).max(1000)
        .describe('What was actually decided/implemented'),
      ai_recommended: z.string().min(1).max(1000)
        .describe('What the AI recommended'),
      human_override: z.boolean()
        .describe('Whether the human overrode the AI recommendation'),
      outcome: z.enum(['success', 'failure', 'partial'])
        .describe('Outcome of the decision'),
      sprint: z.string().min(1).max(100)
        .describe('Sprint phase where the decision was made (e.g., "Phase 72")'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ domain, decision, ai_recommended, human_override, outcome, sprint }) => {
      const ledger = loadTrustLedger();

      const nextId = ledger.decisions.reduce((max, d) => Math.max(max, d.id), 0) + 1;

      const newDecision: TrustDecision = {
        id: nextId,
        domain,
        decision,
        aiRecommended: ai_recommended,
        humanOverride: human_override,
        outcome,
        sprint,
        recordedAt: new Date().toISOString(),
      };

      const updatedLedger: TrustLedger = {
        decisions: [...ledger.decisions, newDecision],
      };
      saveTrustLedger(updatedLedger);

      logger.info('Trust decision recorded', {
        id: nextId,
        domain,
        outcome,
        humanOverride: human_override,
        sprint,
      });

      // Calculate current domain stats for feedback
      const domainStats = calculateDomainStats(updatedLedger.decisions, domain);

      const lines: string[] = [
        `## Decision #${nextId} Recorded`,
        '',
        `**Domain:** ${domain}`,
        `**Decision:** ${decision}`,
        `**AI recommended:** ${ai_recommended}`,
        `**Human override:** ${human_override ? 'Yes' : 'No'}`,
        `**Outcome:** ${outcome}`,
        `**Sprint:** ${sprint}`,
        '',
        `### Current ${domain} Stats`,
        '',
        `- **Total decisions:** ${domainStats.total}`,
        `- **Success rate:** ${formatPercent(domainStats.successRate)}`,
        `- **Override rate:** ${formatPercent(domainStats.overrideRate)}`,
        `- **Trust level:** ${formatTrustLevel(domainStats.trustLevel)}`,
      ];

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
