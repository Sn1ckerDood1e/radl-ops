/**
 * MCP Counterfactual Sprint Analysis Tool
 *
 * Uses Sonnet to reason about alternative sprint outcomes. Given a
 * completed sprint phase and a hypothetical different decision,
 * predicts what would have changed using sprint data and causal
 * graph context.
 *
 * Tool: counterfactual_analyze
 * Cost: ~$0.02 per analysis (Sonnet)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { getRoute, calculateCost } from '../../models/router.js';
import { getAnthropicClient } from '../../config/anthropic.js';
import { trackUsage } from '../../models/token-tracker.js';
import { getConfig } from '../../config/paths.js';
import { loadCausalGraph } from './causal-graph.js';
import { withRetry } from '../../utils/retry.js';

// ============================================
// Types
// ============================================

interface SprintFileData {
  phase: string;
  title: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  completedTasks?: unknown[];
  tasks?: unknown[];
  blockers?: unknown[];
  estimate?: string;
  actual?: string;
  actualTime?: string;
}

// ============================================
// Sprint Data Loading
// ============================================

function getSprintDir(): string {
  return join(getConfig().radlDir, '.planning/sprints');
}

function normalizePhase(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findSprintData(sprintPhase: string): { data: SprintFileData; source: string } | null {
  const sprintDir = getSprintDir();
  const normalizedTarget = normalizePhase(sprintPhase);

  // Search archive for matching phase
  const archiveDir = join(sprintDir, 'archive');
  if (existsSync(archiveDir)) {
    try {
      const files = readdirSync(archiveDir).filter(f => f.endsWith('.json')).sort();
      for (const file of files) {
        const filePath = join(archiveDir, file);
        const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as SprintFileData;
        if (raw.phase && normalizePhase(raw.phase).includes(normalizedTarget)) {
          return { data: raw, source: filePath };
        }
      }
    } catch (error) {
      logger.warn('Failed to search sprint archive', { error: String(error) });
    }
  }

  // Fall back to current sprint
  const currentPath = join(sprintDir, 'current.json');
  if (existsSync(currentPath)) {
    try {
      const data = JSON.parse(readFileSync(currentPath, 'utf-8')) as SprintFileData;
      return { data, source: currentPath };
    } catch (error) {
      logger.warn('Failed to read current sprint', { error: String(error) });
    }
  }

  return null;
}

function formatSprintForPrompt(data: SprintFileData): string {
  const lines: string[] = [
    `Phase: ${data.phase ?? 'Unknown'}`,
    `Title: ${data.title ?? 'Unknown'}`,
    `Status: ${data.status ?? 'Unknown'}`,
  ];

  if (data.startedAt) {
    lines.push(`Started: ${data.startedAt}`);
  }
  if (data.completedAt) {
    lines.push(`Completed: ${data.completedAt}`);
  }
  if (data.estimate) {
    lines.push(`Estimate: ${data.estimate}`);
  }
  if (data.actualTime ?? data.actual) {
    lines.push(`Actual: ${data.actualTime ?? data.actual}`);
  }

  const tasks = data.completedTasks ?? data.tasks ?? [];
  if (Array.isArray(tasks) && tasks.length > 0) {
    lines.push('', 'Tasks:');
    for (const task of tasks) {
      if (typeof task === 'string') {
        lines.push(`- ${task}`);
      } else if (typeof task === 'object' && task !== null) {
        const taskObj = task as Record<string, unknown>;
        const title = taskObj.title ?? taskObj.name ?? JSON.stringify(task);
        const status = taskObj.status ? ` [${taskObj.status}]` : '';
        lines.push(`- ${title}${status}`);
      }
    }
  }

  if (Array.isArray(data.blockers) && data.blockers.length > 0) {
    lines.push('', 'Blockers:');
    for (const blocker of data.blockers) {
      lines.push(`- ${typeof blocker === 'string' ? blocker : JSON.stringify(blocker)}`);
    }
  }

  return lines.join('\n');
}

// ============================================
// Causal Graph Context
// ============================================

function buildCausalContext(sprintPhase: string): string {
  try {
    const graph = loadCausalGraph();

    if (graph.nodes.length === 0) {
      return '';
    }

    // Find nodes related to this sprint
    const normalizedPhase = normalizePhase(sprintPhase);
    const relevantNodes = graph.nodes.filter(node =>
      normalizePhase(node.sprint).includes(normalizedPhase) ||
      normalizePhase(node.label).includes(normalizedPhase),
    );

    if (relevantNodes.length === 0) {
      return '';
    }

    const relevantNodeIds = new Set(relevantNodes.map(n => n.id));

    // Find edges connecting relevant nodes (or pointing to/from them)
    const relevantEdges = graph.edges.filter(
      edge => relevantNodeIds.has(edge.from) || relevantNodeIds.has(edge.to),
    );

    const lines: string[] = [
      '',
      '## Known Causal Relationships for this Sprint',
      '',
    ];

    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));

    for (const node of relevantNodes) {
      const prefix = node.type === 'decision' ? 'Decision' : node.type === 'outcome' ? 'Outcome' : 'Condition';
      lines.push(`- [${prefix}] ${node.label}`);
    }

    if (relevantEdges.length > 0) {
      lines.push('', 'Causal chains:');
      for (const edge of relevantEdges) {
        const fromNode = nodeMap.get(edge.from);
        const toNode = nodeMap.get(edge.to);
        const fromLabel = fromNode ? fromNode.label : edge.from;
        const toLabel = toNode ? toNode.label : edge.to;
        lines.push(`- ${fromLabel} -> ${toLabel} (strength: ${edge.strength}/10, evidence: ${edge.evidence})`);
      }
    }

    return lines.join('\n');
  } catch (error) {
    logger.warn('Failed to build causal context', { error: String(error) });
    return '';
  }
}

// ============================================
// Sonnet Counterfactual Analysis
// ============================================

const COUNTERFACTUAL_SYSTEM = `You are an expert in software engineering retrospectives and counterfactual reasoning.

Given sprint data (tasks completed, time spent, decisions made, blockers encountered) and optionally a causal graph of decision->outcome relationships, analyze what would have happened if a different decision had been made.

Your analysis should be:
1. **Specific** — Reference actual tasks, timelines, and decisions from the sprint data
2. **Balanced** — Consider both positive and negative consequences of the alternative
3. **Realistic** — Ground predictions in software engineering experience
4. **Actionable** — Highlight lessons that apply to future sprints

Structure your response with these sections:
- **Time Impact**: How would the timeline have changed?
- **Quality Impact**: How would code quality, test coverage, or reliability differ?
- **Risk Changes**: What new risks would emerge or be mitigated?
- **Cascade Effects**: What downstream consequences would follow?
- **Confidence Level**: How confident are you in this analysis? (Low/Medium/High) and why.
- **Key Takeaway**: One sentence summary of the most important insight.`;

async function runCounterfactualAnalysis(
  sprintContext: string,
  causalContext: string,
  alternativeDecision: string,
): Promise<{ analysis: string; inputTokens: number; outputTokens: number }> {
  const route = getRoute('review');
  const client = getAnthropicClient();

  const userPrompt = [
    '## Sprint Context',
    '',
    sprintContext,
    causalContext,
    '',
    '## Alternative Decision to Analyze',
    '',
    alternativeDecision,
    '',
    'Given this sprint\'s context, if we had made this alternative decision, what would likely have happened differently? Consider: time impact, quality impact, risk changes, cascade effects.',
  ].join('\n');

  const response = await withRetry(
    () => client.messages.create({
      model: route.model,
      max_tokens: route.maxTokens,
      system: COUNTERFACTUAL_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    { maxRetries: 2, baseDelayMs: 1000 },
  );

  const textBlock = response.content.find(b => b.type === 'text');
  const analysis = textBlock && 'text' in textBlock ? textBlock.text : 'No analysis generated.';

  return {
    analysis,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

// ============================================
// Output Formatting
// ============================================

function formatCounterfactualReport(
  sprintPhase: string,
  sprintTitle: string,
  alternativeDecision: string,
  analysis: string,
  cost: number,
): string {
  const lines: string[] = [
    `## Counterfactual Analysis: ${sprintPhase}`,
    '',
    `**Sprint:** ${sprintTitle}`,
    `**Alternative Decision:** ${alternativeDecision}`,
    '',
    '---',
    '',
    analysis,
    '',
    '---',
    '',
    `_Analysis cost: $${cost.toFixed(4)} (Sonnet)_`,
  ];

  return lines.join('\n');
}

// ============================================
// MCP Registration
// ============================================

export function registerCounterfactualTools(server: McpServer): void {
  server.tool(
    'counterfactual_analyze',
    'Analyze alternative sprint outcomes using AI reasoning. Given a completed sprint phase and a hypothetical different decision, predicts what would have changed. Uses Sonnet for counterfactual reasoning.',
    {
      sprint_phase: z.string().describe('Sprint phase to analyze (e.g. "Phase 69")'),
      alternative_decision: z.string().min(10).describe('The alternative decision to explore'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    withErrorTracking('counterfactual_analyze', async ({ sprint_phase, alternative_decision }) => {
      logger.info('Counterfactual analysis starting', {
        sprint_phase,
        alternative_decision: alternative_decision.slice(0, 100),
      });

      // 1. Load sprint data
      const sprint = findSprintData(sprint_phase);
      const sprintContext = sprint
        ? formatSprintForPrompt(sprint.data)
        : `No sprint data available for "${sprint_phase}". Analyzing based on the alternative decision alone.`;

      const sprintTitle = sprint
        ? `${sprint.data.phase ?? sprint_phase} - ${sprint.data.title ?? 'Unknown'}`
        : sprint_phase;

      // 2. Load causal graph context
      const causalContext = buildCausalContext(sprint_phase);

      // 3. Call Sonnet for counterfactual reasoning
      const { analysis, inputTokens, outputTokens } = await runCounterfactualAnalysis(
        sprintContext,
        causalContext,
        alternative_decision,
      );

      // 4. Track costs
      const route = getRoute('review');
      const cost = calculateCost(route.model, inputTokens, outputTokens);

      trackUsage(
        route.model,
        inputTokens,
        outputTokens,
        'review',
        'counterfactual-analyze',
      );

      // 5. Format and return
      const report = formatCounterfactualReport(
        sprint_phase,
        sprintTitle,
        alternative_decision,
        analysis,
        cost,
      );

      logger.info('Counterfactual analysis complete', {
        sprint_phase,
        inputTokens,
        outputTokens,
        cost,
      });

      return { content: [{ type: 'text' as const, text: report }] };
    }),
  );
}
