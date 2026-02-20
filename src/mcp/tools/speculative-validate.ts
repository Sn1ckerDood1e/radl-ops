/**
 * MCP Speculative Validation Tool
 *
 * Zero-cost pre-validation of sprint tasks against the knowledge base.
 * Runs 5 checks with no AI calls ($0 cost):
 *
 * 1. Data flow coverage — Prisma changes must touch all layers
 * 2. Antibody matching — known bug patterns from immune system
 * 3. Crystallized check matching — promoted lessons from crystallization
 * 4. Genome risk prediction — sprint risk from genome model (if available)
 * 5. Causal risk — decision->outcome chains from causal graph
 *
 * Returns a structured report with issues, severity levels, and overall
 * risk score (0-100).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { matchAntibodies, matchAntibodyChains, loadAntibodies, saveAntibodies } from './immune-system.js';
import type { ChainWarning } from './immune-system.js';
import { matchCrystallizedChecks, loadCrystallized, saveCrystallized } from './crystallization.js';
import { findRelevantCauses, loadCausalGraph } from './causal-graph.js';

// ============================================
// Types
// ============================================

export interface ValidationTask {
  title: string;
  description: string;
  files?: string[];
}

export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ValidationIssue {
  check: string;
  severity: IssueSeverity;
  task: string;
  message: string;
  suggestion?: string;
}

export interface ValidationReport {
  title: string;
  taskCount: number;
  issues: ValidationIssue[];
  riskScore: number;
  checksRun: string[];
  summary: string;
}

// ============================================
// Data Flow Coverage Check
// ============================================

interface DataFlowGap {
  task: string;
  missingLayers: string[];
}

const PRISMA_PATTERNS = ['prisma/schema.prisma', '.prisma'];

const DATA_FLOW_LAYERS: Array<{
  name: string;
  patterns: string[];
}> = [
  { name: 'migration', patterns: ['supabase/migrations/', 'prisma/migrations/'] },
  { name: 'validation', patterns: ['src/lib/validations/'] },
  { name: 'api-handler', patterns: ['src/app/api/'] },
  { name: 'client-component', patterns: ['src/components/', 'src/app/('] },
];

function hasPrismaChanges(files: string[]): boolean {
  return files.some(file =>
    PRISMA_PATTERNS.some(pattern => file.includes(pattern)),
  );
}

function findMissingDataFlowLayers(files: string[]): string[] {
  const missing: string[] = [];

  for (const layer of DATA_FLOW_LAYERS) {
    const hasLayer = files.some(file =>
      layer.patterns.some(pattern => file.includes(pattern)),
    );
    if (!hasLayer) {
      missing.push(layer.name);
    }
  }

  return missing;
}

function checkDataFlowCoverage(tasks: ValidationTask[]): DataFlowGap[] {
  const gaps: DataFlowGap[] = [];

  for (const task of tasks) {
    const files = task.files ?? [];
    if (files.length === 0) continue;

    if (hasPrismaChanges(files)) {
      const missingLayers = findMissingDataFlowLayers(files);
      if (missingLayers.length > 0) {
        gaps.push({
          task: task.title,
          missingLayers,
        });
      }
    }
  }

  return gaps;
}

// ============================================
// Antibody Matching Check
// ============================================

interface AntibodyMatch {
  task: string;
  antibodyId: number;
  trigger: string;
  check: string;
}

interface AntibodyCheckResult {
  matches: AntibodyMatch[];
  chainWarnings: ChainWarning[];
}

function checkAntibodies(tasks: ValidationTask[]): AntibodyCheckResult {
  const store = loadAntibodies();
  const activeAntibodies = store.antibodies.filter(ab => ab.active);

  const matches: AntibodyMatch[] = [];
  const matchedIds = new Set<number>();
  const allChainWarnings: ChainWarning[] = [];

  for (const task of tasks) {
    const searchText = `${task.title} ${task.description} ${(task.files ?? []).join(' ')}`;

    // Individual antibody matching (active only)
    if (activeAntibodies.length > 0) {
      const matched = matchAntibodies(searchText, activeAntibodies);
      for (const ab of matched) {
        matches.push({
          task: task.title,
          antibodyId: ab.id,
          trigger: ab.trigger,
          check: ab.check,
        });
        matchedIds.add(ab.id);
      }
    }

    // Compound chain detection (checks all antibodies for chain-linked patterns)
    const chains = matchAntibodyChains(searchText, store.antibodies);
    for (const chain of chains) {
      allChainWarnings.push(chain);
    }
  }

  // Increment catches on matched antibodies
  if (matchedIds.size > 0) {
    const updatedStore = {
      antibodies: store.antibodies.map(ab =>
        matchedIds.has(ab.id) ? { ...ab, catches: ab.catches + 1 } : ab
      ),
    };
    saveAntibodies(updatedStore);
  }

  return { matches, chainWarnings: allChainWarnings };
}

// ============================================
// Crystallized Check Matching
// ============================================

interface CrystallizedMatch {
  task: string;
  checkId: number;
  trigger: string;
  check: string;
}

function checkCrystallized(tasks: ValidationTask[]): CrystallizedMatch[] {
  const crystallized = loadCrystallized();
  const activeChecks = crystallized.checks.filter(c => c.status === 'active');

  if (activeChecks.length === 0) {
    return [];
  }

  const matches: CrystallizedMatch[] = [];
  const matchedIds = new Set<number>();

  for (const task of tasks) {
    const searchText = `${task.title} ${task.description} ${(task.files ?? []).join(' ')}`;
    const matched = matchCrystallizedChecks(searchText, activeChecks);

    for (const check of matched) {
      matches.push({
        task: task.title,
        checkId: check.id,
        trigger: check.trigger,
        check: check.check,
      });
      matchedIds.add(check.id);
    }
  }

  // Increment catches on matched crystallized checks
  if (matchedIds.size > 0) {
    const updatedCrystallized = {
      checks: crystallized.checks.map(c =>
        matchedIds.has(c.id) ? { ...c, catches: c.catches + 1 } : c
      ),
    };
    saveCrystallized(updatedCrystallized);
  }

  return matches;
}

// ============================================
// Genome Risk Prediction (Optional)
// ============================================

interface GenomeRisk {
  riskLevel: string;
  factors: string[];
}

// Use a variable to prevent tsc from statically resolving the optional module
const GENOME_MODULE_PATH = './shared/sprint-genome.js';

async function checkGenomeRisk(
  _tasks: ValidationTask[],
  _estimate?: string,
): Promise<GenomeRisk | null> {
  try {
    // Dynamic import of optional module — may not exist yet
    const genome = await import(/* @vite-ignore */ GENOME_MODULE_PATH) as {
      predictRisk?: (tasks: ValidationTask[], estimate?: string) => GenomeRisk;
    };
    if (typeof genome.predictRisk === 'function') {
      const result = genome.predictRisk(_tasks, _estimate);
      return result;
    }
    return null;
  } catch {
    // sprint-genome.js doesn't exist yet — skip gracefully
    return null;
  }
}

// ============================================
// Causal Risk Check
// ============================================

interface CausalRisk {
  task: string;
  chains: string[];
  nodeCount: number;
}

function checkCausalRisks(tasks: ValidationTask[]): CausalRisk[] {
  const graph = loadCausalGraph();

  if (graph.nodes.length === 0) {
    return [];
  }

  const risks: CausalRisk[] = [];

  for (const task of tasks) {
    const keywords = extractKeywords(task.title, task.description);
    if (keywords.length === 0) continue;

    const result = findRelevantCauses(graph, keywords);

    if (result.chains.length > 0) {
      risks.push({
        task: task.title,
        chains: result.chains,
        nodeCount: result.nodes.length,
      });
    }
  }

  return risks;
}

function extractKeywords(title: string, description: string): string[] {
  const combined = `${title} ${description}`.toLowerCase();
  const words = combined.split(/\s+/).filter(w => w.length >= 4);
  // Deduplicate
  return [...new Set(words)];
}

// ============================================
// Risk Score Calculation
// ============================================

const SEVERITY_WEIGHTS: Record<IssueSeverity, number> = {
  critical: 25,
  high: 15,
  medium: 8,
  low: 3,
};

function calculateRiskScore(issues: ValidationIssue[]): number {
  if (issues.length === 0) return 0;

  const rawScore = issues.reduce(
    (total, issue) => total + SEVERITY_WEIGHTS[issue.severity],
    0,
  );

  return Math.min(100, rawScore);
}

// ============================================
// Report Building
// ============================================

function buildIssues(
  dataFlowGaps: DataFlowGap[],
  antibodyMatches: AntibodyMatch[],
  chainWarnings: ChainWarning[],
  crystallizedMatches: CrystallizedMatch[],
  genomeRisk: GenomeRisk | null,
  causalRisks: CausalRisk[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Data flow gaps are critical — Phase 69 class of bug
  for (const gap of dataFlowGaps) {
    issues.push({
      check: 'data-flow-coverage',
      severity: gap.missingLayers.length >= 3 ? 'critical' : 'high',
      task: gap.task,
      message: `Prisma schema changes detected but missing: ${gap.missingLayers.join(', ')}`,
      suggestion: `Add files for: ${gap.missingLayers.map(l => {
        switch (l) {
          case 'migration': return 'supabase/migrations/* or prisma/migrations/*';
          case 'validation': return 'src/lib/validations/*';
          case 'api-handler': return 'src/app/api/*';
          case 'client-component': return 'src/components/* or page files';
          default: return l;
        }
      }).join(', ')}`,
    });
  }

  // Antibody chain warnings are critical — compound risk patterns
  for (const chain of chainWarnings) {
    issues.push({
      check: 'antibody-chain',
      severity: 'critical',
      task: '(cross-task)',
      message: chain.message,
      suggestion: `Review all antibodies in chain: ${chain.antibodyIds.map(id => `#${id}`).join(', ')}`,
    });
  }

  // Antibody matches are high — known bug patterns
  for (const match of antibodyMatches) {
    issues.push({
      check: 'antibody-match',
      severity: 'high',
      task: match.task,
      message: `Antibody #${match.antibodyId}: ${match.trigger}`,
      suggestion: match.check,
    });
  }

  // Crystallized checks are medium — learned lessons
  for (const match of crystallizedMatches) {
    issues.push({
      check: 'crystallized-check',
      severity: 'medium',
      task: match.task,
      message: `Crystallized Check #${match.checkId}: ${match.trigger}`,
      suggestion: match.check,
    });
  }

  // Genome risk is medium — predictive
  if (genomeRisk) {
    issues.push({
      check: 'genome-risk',
      severity: genomeRisk.riskLevel === 'high' ? 'high' : 'medium',
      task: '(sprint-wide)',
      message: `Sprint genome risk: ${genomeRisk.riskLevel}`,
      suggestion: genomeRisk.factors.length > 0
        ? `Risk factors: ${genomeRisk.factors.join(', ')}`
        : undefined,
    });
  }

  // Causal risks are low — informational historical context
  for (const risk of causalRisks) {
    issues.push({
      check: 'causal-risk',
      severity: 'low',
      task: risk.task,
      message: `${risk.nodeCount} related causal nodes found`,
      suggestion: risk.chains.length > 0
        ? `Causal chains: ${risk.chains.slice(0, 3).join('; ')}`
        : undefined,
    });
  }

  return issues;
}

function formatReport(report: ValidationReport): string {
  const lines: string[] = [
    `## Speculative Validation Report`,
    '',
  ];

  if (report.title) {
    lines.push(`**Sprint:** ${report.title}`);
  }

  lines.push(`**Tasks:** ${report.taskCount}`);
  lines.push(`**Risk Score:** ${report.riskScore}/100`);
  lines.push(`**Checks Run:** ${report.checksRun.join(', ')}`);
  lines.push('');

  if (report.issues.length === 0) {
    lines.push('No issues found. All checks passed.');
    lines.push('');
  } else {
    const critical = report.issues.filter(i => i.severity === 'critical');
    const high = report.issues.filter(i => i.severity === 'high');
    const medium = report.issues.filter(i => i.severity === 'medium');
    const low = report.issues.filter(i => i.severity === 'low');

    lines.push(`**Issues:** ${report.issues.length} total (${critical.length} critical, ${high.length} high, ${medium.length} medium, ${low.length} low)`);
    lines.push('');

    const issuesByCheck = new Map<string, ValidationIssue[]>();
    for (const issue of report.issues) {
      const existing = issuesByCheck.get(issue.check) ?? [];
      issuesByCheck.set(issue.check, [...existing, issue]);
    }

    for (const [check, checkIssues] of issuesByCheck) {
      lines.push(`### ${check}`);
      lines.push('');
      for (const issue of checkIssues) {
        const severityTag = issue.severity.toUpperCase();
        lines.push(`- **[${severityTag}]** ${issue.task}: ${issue.message}`);
        if (issue.suggestion) {
          lines.push(`  _Suggestion: ${issue.suggestion}_`);
        }
      }
      lines.push('');
    }
  }

  lines.push(`---`);
  lines.push(`_${report.summary}_`);

  return lines.join('\n');
}

// ============================================
// Core Logic (exported for sprint-conductor)
// ============================================

export interface SpeculativeValidationOptions {
  estimate?: string;
  title?: string;
}

export async function runSpeculativeValidation(
  tasks: ValidationTask[],
  options?: SpeculativeValidationOptions,
): Promise<ValidationReport> {
  const checksRun: string[] = [];

  // 1. Data flow coverage
  const dataFlowGaps = checkDataFlowCoverage(tasks);
  checksRun.push('data-flow-coverage');

  // 2. Antibody matching (includes chain detection)
  const { matches: antibodyMatches, chainWarnings } = checkAntibodies(tasks);
  checksRun.push('antibody-match');

  // 3. Crystallized check matching
  const crystallizedMatches = checkCrystallized(tasks);
  checksRun.push('crystallized-check');

  // 4. Genome risk (optional, may not exist)
  const genomeRisk = await checkGenomeRisk(tasks, options?.estimate);
  checksRun.push('genome-risk');

  // 5. Causal risk
  const causalRisks = checkCausalRisks(tasks);
  checksRun.push('causal-risk');

  // Build issues list
  const issues = buildIssues(
    dataFlowGaps,
    antibodyMatches,
    chainWarnings,
    crystallizedMatches,
    genomeRisk,
    causalRisks,
  );

  const riskScore = calculateRiskScore(issues);

  const summary = issues.length === 0
    ? `Zero-cost validation passed. ${tasks.length} tasks checked against knowledge base.`
    : `Found ${issues.length} issues across ${checksRun.length} checks. Risk score: ${riskScore}/100.`;

  logger.info('Speculative validation complete', {
    taskCount: tasks.length,
    issueCount: issues.length,
    riskScore,
    checksRun,
  });

  return {
    title: options?.title ?? '',
    taskCount: tasks.length,
    issues,
    riskScore,
    checksRun,
    summary,
  };
}

// ============================================
// MCP Registration
// ============================================

export function registerSpeculativeValidateTools(server: McpServer): void {
  server.tool(
    'speculative_validate',
    'Pre-validate sprint tasks against knowledge base. Zero-cost checks for data flow gaps, known bugs (antibodies), crystallized lessons, and causal risks.',
    {
      tasks: z.array(z.object({
        title: z.string(),
        description: z.string(),
        files: z.array(z.string()).optional(),
      })).describe('Sprint tasks to validate'),
      estimate: z.string().optional().describe('Sprint time estimate for calibration check'),
      title: z.string().optional().describe('Sprint title for context'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    withErrorTracking('speculative_validate', async ({ tasks, estimate, title }) => {
      const report = await runSpeculativeValidation(tasks, { estimate, title });
      const formatted = formatReport(report);

      return {
        content: [{ type: 'text' as const, text: formatted }],
      };
    }),
  );
}
