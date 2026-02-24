/**
 * Tool Guide — self-documenting tool registry with preference chains.
 *
 * Returns categories, recommended tool chains, and performance hints
 * to help the agent select the right tool for the job.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';

interface ToolChain {
  name: string;
  description: string;
  chain: Array<{ tool: string; when: string; cost: 'zero' | 'low' | 'medium' | 'high' }>;
}

const TOOL_CHAINS: ToolChain[] = [
  {
    name: 'verification',
    description: 'Increasing verification depth',
    chain: [
      { tool: 'verify (level 1)', when: 'Quick file existence check', cost: 'zero' },
      { tool: 'verify (level 2)', when: 'Check for TODO/placeholder stubs', cost: 'zero' },
      { tool: 'verify (level 3)', when: 'Verify imports and wiring', cost: 'zero' },
      { tool: 'pre_flight_check', when: 'Pre-push verification (branch, clean tree, secrets)', cost: 'zero' },
      { tool: 'verify (level 4)', when: 'Full typecheck + build + test', cost: 'zero' },
      { tool: 'verify_data_flow', when: 'Field lifecycle: Schema→Migration→Validation→API→Client', cost: 'zero' },
    ],
  },
  {
    name: 'knowledge',
    description: 'Knowledge retrieval (escalating depth)',
    chain: [
      { tool: 'knowledge_query', when: 'Search patterns, lessons, decisions by keyword', cost: 'zero' },
      { tool: 'causal_query', when: 'Trace cause→effect relationships', cost: 'zero' },
      { tool: 'inverse_bloom', when: 'Find knowledge gaps for a task', cost: 'zero' },
      { tool: 'speculative_validate', when: 'Pre-validate a plan against knowledge base', cost: 'zero' },
    ],
  },
  {
    name: 'sprint-lifecycle',
    description: 'Sprint management workflow',
    chain: [
      { tool: 'sprint_conductor', when: 'Full orchestration: knowledge→spec→decompose→plan', cost: 'high' },
      { tool: 'sprint_start', when: 'Begin tracking a sprint', cost: 'zero' },
      { tool: 'sprint_progress', when: 'Record task completion', cost: 'zero' },
      { tool: 'sprint_complete', when: 'Finish sprint + extract learnings (Bloom)', cost: 'medium' },
      { tool: 'sprint_retrospective', when: 'AI analysis of sprint quality', cost: 'low' },
    ],
  },
  {
    name: 'review',
    description: 'Code review workflow',
    chain: [
      { tool: 'spec_compliance', when: 'Stage 1: check against acceptance criteria', cost: 'zero' },
      { tool: 'spot_check_diff', when: 'Quick AI spot-check of git diffs', cost: 'low' },
      { tool: 'verify_patterns', when: 'Check diffs against knowledge base patterns', cost: 'zero' },
      { tool: 'record_review', when: 'Record findings from external reviewers', cost: 'zero' },
      { tool: 'resolve_review', when: 'Mark findings as fixed/deferred', cost: 'zero' },
      { tool: 'review_pipeline', when: 'Full review workflow: recipe + triage + checklist', cost: 'zero' },
    ],
  },
  {
    name: 'intelligence',
    description: 'Closed-loop learning system',
    chain: [
      { tool: 'antibody_create', when: 'Create guard from a bug pattern', cost: 'low' },
      { tool: 'crystallize_propose', when: 'Promote frequent lesson to permanent check', cost: 'low' },
      { tool: 'causal_extract', when: 'Extract decision→outcome pairs from sprint', cost: 'low' },
      { tool: 'trust_report', when: 'Analytics on decision quality by domain', cost: 'zero' },
      { tool: 'trust_record', when: 'Record decision outcome for quality ratchet', cost: 'zero' },
    ],
  },
  {
    name: 'session',
    description: 'Session management',
    chain: [
      { tool: 'session_health', when: 'Detect thrashing, stalls, high error rates', cost: 'zero' },
      { tool: 'cognitive_load', when: 'Predict context window overflow', cost: 'zero' },
      { tool: 'health_check', when: 'Check external service health', cost: 'zero' },
      { tool: 'production_status', when: 'Aggregated prod health (Vercel+Supabase+Sentry)', cost: 'zero' },
      { tool: 'alert_check', when: 'Check for critical production alerts', cost: 'zero' },
    ],
  },
  {
    name: 'planning',
    description: 'Task planning and decomposition',
    chain: [
      { tool: 'sprint_advisor', when: 'Recommend team usage for task list', cost: 'low' },
      { tool: 'sprint_decompose', when: 'Auto-decompose into structured tasks', cost: 'low' },
      { tool: 'team_recipe', when: 'Get agent team setup recipe', cost: 'zero' },
      { tool: 'auto_prioritize', when: 'Prioritize deferred items by impact/effort', cost: 'low' },
    ],
  },
];

export function registerToolGuideTools(server: McpServer): void {
  server.tool(
    'tool_guide',
    'Self-documenting tool registry. Returns categories, preference chains, and cost hints. Use to find the right tool for a task.',
    {
      category: z.string().optional()
        .describe('Filter by category (verification, knowledge, sprint-lifecycle, review, intelligence, session, planning). Omit for all.'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    withErrorTracking('tool_guide', async ({ category }) => {
      const chains = category
        ? TOOL_CHAINS.filter(c => c.name === category)
        : TOOL_CHAINS;

      if (chains.length === 0) {
        const available = TOOL_CHAINS.map(c => c.name).join(', ');
        return { content: [{ type: 'text' as const, text: `Unknown category "${category}". Available: ${available}` }] };
      }

      const lines: string[] = ['# Tool Guide', ''];

      for (const chain of chains) {
        lines.push(`## ${chain.name}: ${chain.description}`);
        lines.push('');
        for (const step of chain.chain) {
          const costIcon = step.cost === 'zero' ? '$0'
            : step.cost === 'low' ? '$'
            : step.cost === 'medium' ? '$$'
            : '$$$';
          lines.push(`  ${costIcon} **${step.tool}** — ${step.when}`);
        }
        lines.push('');
      }

      lines.push('## Quick Reference');
      lines.push('');
      lines.push('- $0 = zero-cost (no AI calls, in-memory or file analysis)');
      lines.push('- $ = low cost (single Haiku call)');
      lines.push('- $$ = medium cost (Sonnet or multi-step pipeline)');
      lines.push('- $$$ = high cost (eval-opt loop or Opus)');

      logger.info('Tool guide queried', { category: category ?? 'all' });

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    })
  );
}
