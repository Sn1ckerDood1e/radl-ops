/**
 * MCP Briefing Tools - Quality-assured briefings via eval-opt loop
 *
 * Uses Haiku to generate, Sonnet to evaluate. Multi-model orchestration
 * that Claude Code cannot do natively - this is the core value-add.
 *
 * GitHub data is NOT gathered internally (Claude Code has mcp__github__* for that).
 * Instead, pass github_context as a string parameter.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { runEvalOptLoop } from '../../patterns/evaluator-optimizer.js';
import { getAnthropicClient } from '../../config/anthropic.js';
import { getRoute } from '../../models/router.js';
import { getCostSummaryForBriefing } from '../../models/token-tracker.js';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';
import { withRetry } from '../../utils/retry.js';
import { readFileSync, existsSync } from 'fs';
import { getConfig } from '../../config/paths.js';

interface DeferredItem {
  title: string;
  effort: string;
  sprintPhase: string;
  resolved: boolean;
}

interface DeferredStore {
  items: DeferredItem[];
}

function loadDeferredItems(): DeferredStore {
  const path = `${getConfig().knowledgeDir}/deferred.json`;
  if (!existsSync(path)) return { items: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as DeferredStore;
  } catch {
    return { items: [] };
  }
}

function getDeferredSummary(): string {
  const store = loadDeferredItems();
  const unresolved = store.items.filter(i => !i.resolved);
  if (unresolved.length === 0) return '';

  const byEffort = { small: 0, medium: 0, large: 0 };
  for (const item of unresolved) {
    const effort = item.effort as keyof typeof byEffort;
    if (effort in byEffort) byEffort[effort]++;
  }

  const lines = [
    `${unresolved.length} unresolved (${byEffort.small} small, ${byEffort.medium} medium, ${byEffort.large} large)`,
  ];

  // Show oldest 3 items
  const oldest = unresolved.slice(0, 3);
  for (const item of oldest) {
    lines.push(`- [${item.effort}] ${item.title} (from ${item.sprintPhase})`);
  }

  return lines.join('\n');
}

function countDeferred(): number {
  const store = loadDeferredItems();
  return store.items.filter(i => !i.resolved).length;
}

const DAILY_BRIEFING_CRITERIA = [
  'Completeness: Covers summary, metrics, priorities, blockers, wins, and API costs',
  'Accuracy: All facts and data are correct and current',
  'Actionability: Clear next steps with specific priorities identified',
  'Conciseness: No fluff, appropriate length for a 2-minute read',
  'Formatting: Well-structured with headers, bullet points, and visual hierarchy',
];

const WEEKLY_BRIEFING_CRITERIA = [
  'Completeness: Covers review, progress, metrics, challenges, goals, strategy, and costs',
  'Accuracy: All facts, trends, and data are correct',
  'Strategic insight: Identifies patterns and provides forward-looking analysis',
  'Actionability: Next week goals are specific and achievable',
  'Organization: Well-structured with clear headers and logical flow',
];

export function registerBriefingTools(server: McpServer): void {
  server.tool(
    'daily_briefing',
    'Generate a daily briefing for Radl with eval-opt quality loop (Haiku generates, Sonnet evaluates). Pass GitHub data via github_context if available.',
    {
      github_context: z.string().max(5000).optional()
        .describe('GitHub data to include (open issues, PRs, recent commits). Gather with mcp__github__* tools and pass here.'),
      monitoring_context: z.string().max(3000).optional()
        .describe('Production status from production_status tool output. Include deployment health, error counts, service status.'),
      calendar_context: z.string().max(2000).optional()
        .describe('Today\'s calendar events from Google Calendar MCP. Include meetings, blocked time, deadlines.'),
      deferred_context: z.string().max(2000).optional()
        .describe('Deferred tech debt summary. Auto-populated if omitted — pass "none" to skip.'),
      custom_focus: z.string().max(500).optional()
        .describe('Custom area to focus on in the briefing'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    withErrorTracking('daily_briefing', async ({ github_context, monitoring_context, calendar_context, deferred_context, custom_focus }) => {
      const costSummary = getCostSummaryForBriefing();
      const date = new Date().toISOString().split('T')[0];

      // Auto-populate deferred context if not provided
      const deferredSummary = deferred_context === 'none' ? ''
        : deferred_context ?? getDeferredSummary();

      const prompt = `Generate a concise daily briefing for Radl (a rowing team management SaaS).

Date: ${date}

${github_context ? `GitHub Activity:\n${github_context}\n` : ''}
${monitoring_context ? `Production Status:\n${monitoring_context}\n` : ''}
${calendar_context ? `Today's Calendar:\n${calendar_context}\n` : ''}
${deferredSummary ? `Tech Debt (${countDeferred()} items):\n${deferredSummary}\n` : ''}
API Costs: ${costSummary}
${custom_focus ? `\nCustom focus area: ${custom_focus}` : ''}

Format the briefing as:
1. **Summary** - 2-3 sentence overview
2. **Key Metrics** - Important numbers at a glance
3. **Today's Priorities** - Top 3-5 actionable items (consider calendar and tech debt)
4. **Production Health** - Service status and any issues (if monitoring data available)
5. **Blockers/Risks** - Any issues that need attention
6. **Wins** - Recent accomplishments to celebrate
7. **API Costs** - Token usage and costs

Keep it brief and actionable. Use bullet points.`;

      const result = await runEvalOptLoop(prompt, {
        generatorTaskType: 'briefing',
        evaluatorTaskType: 'review',
        qualityThreshold: 7,
        maxIterations: 2,
        evaluationCriteria: DAILY_BRIEFING_CRITERIA,
      });

      logger.info('MCP daily briefing generated', {
        score: result.finalScore,
        iterations: result.iterations,
        converged: result.converged,
        costUsd: result.totalCostUsd,
      });

      const errorInfo = result.errors.length > 0
        ? `\n\n**ERRORS:**\n${result.errors.map(e => `- ${e}`).join('\n')}`
        : '';
      const meta = `\n\n---\n_Quality: ${result.finalScore}/10 | Iterations: ${result.iterations} | Converged: ${result.converged} | Eval cost: $${result.totalCostUsd}_`;
      return { content: [{ type: 'text' as const, text: result.finalOutput + errorInfo + meta }] };
    })
  );

  server.tool(
    'weekly_briefing',
    'Generate a comprehensive weekly briefing with trends, progress, and goals. Uses eval-opt quality loop.',
    {
      github_context: z.string().max(10000).optional()
        .describe('GitHub data for the week (commits, PRs merged, issues closed)'),
      monitoring_context: z.string().max(3000).optional()
        .describe('Production status summary for the week. Include uptime, incidents, deployment stats.'),
      calendar_context: z.string().max(3000).optional()
        .describe('Week\'s calendar summary from Google Calendar MCP. Include sprints completed, meetings held.'),
      week_start: z.string().optional()
        .describe('Start date of the week (YYYY-MM-DD, defaults to 7 days ago)'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    withErrorTracking('weekly_briefing', async ({ github_context, monitoring_context, calendar_context, week_start }) => {
      const start = week_start ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const end = new Date().toISOString().split('T')[0];
      const costSummary = getCostSummaryForBriefing();
      const deferredSummary = getDeferredSummary();

      const prompt = `Generate a comprehensive weekly briefing for Radl (a rowing team management SaaS).

Week: ${start} to ${end}

${github_context ? `GitHub Activity:\n${github_context}\n` : ''}
${monitoring_context ? `Production Health This Week:\n${monitoring_context}\n` : ''}
${calendar_context ? `Calendar Summary:\n${calendar_context}\n` : ''}
${deferredSummary ? `Tech Debt Backlog (${countDeferred()} items):\n${deferredSummary}\n` : ''}
API Costs: ${costSummary}

Format the briefing as:
1. **Week in Review** - High-level summary of the week
2. **Development Progress** - Features shipped, bugs fixed, technical debt addressed
3. **Production Health** - Deployment success rate, incidents, error trends
4. **Metrics & Trends** - Key numbers and how they changed
5. **Challenges Faced** - Problems encountered and how they were addressed
6. **Tech Debt Status** - Items addressed, new items added, aging items
7. **Next Week's Goals** - Top 3-5 priorities for the coming week
8. **Strategic Notes** - Any longer-term considerations
9. **API Costs** - Weekly token usage and costs

Be thorough but organized. Use headers and bullet points.`;

      const result = await runEvalOptLoop(prompt, {
        generatorTaskType: 'briefing',
        evaluatorTaskType: 'review',
        qualityThreshold: 7,
        maxIterations: 2,
        evaluationCriteria: WEEKLY_BRIEFING_CRITERIA,
      });

      logger.info('MCP weekly briefing generated', {
        score: result.finalScore,
        iterations: result.iterations,
        converged: result.converged,
      });

      const errorInfo = result.errors.length > 0
        ? `\n\n**ERRORS:**\n${result.errors.map(e => `- ${e}`).join('\n')}`
        : '';
      const meta = `\n\n---\n_Quality: ${result.finalScore}/10 | Iterations: ${result.iterations} | Converged: ${result.converged} | Eval cost: $${result.totalCostUsd}_`;
      return { content: [{ type: 'text' as const, text: result.finalOutput + errorInfo + meta }] };
    })
  );

  server.tool(
    'roadmap_ideas',
    'Brainstorm and prioritize feature ideas for Radl roadmap. Uses Opus for deep strategic reasoning.',
    {
      focus_area: z.string().max(200).optional()
        .describe('Area to focus ideation on (e.g., "athlete experience", "coach tools")'),
      constraint: z.string().max(200).optional()
        .describe('Constraints to consider (e.g., "solo developer", "launch in 2 months")'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    withErrorTracking('roadmap_ideas', async ({ focus_area, constraint }) => {
      const route = getRoute('roadmap');
      const client = getAnthropicClient();

      const prompt = `You are a product strategist for Radl, a rowing team management SaaS.

Core value: Coaches plan practices with lineups; athletes know where to be.
Stack: Next.js, Supabase, Vercel. Solo developer.
Current features: Auth, teams, equipment tracking, athlete roster, lineup management.

${focus_area ? `Focus area: ${focus_area}` : 'Generate ideas across all areas.'}
${constraint ? `Constraint: ${constraint}` : ''}

Generate 5-7 feature ideas ranked by impact. For each:
1. **Name** - Short, descriptive
2. **Impact** (1-10) - How much value for users
3. **Effort** (1-10) - Implementation complexity
4. **Description** - 2-3 sentences on what it does
5. **Why now** - Why this is timely

Prioritize by impact/effort ratio. Be specific to rowing, not generic SaaS advice.`;

      try {
        const response = await withRetry(
          () => client.messages.create({
            model: route.model,
            max_tokens: route.maxTokens,
            messages: [{ role: 'user', content: prompt }],
          }),
        );

        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('\n');

        return { content: [{ type: 'text' as const, text }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Roadmap ideas API call failed', { error: msg });
        return { content: [{ type: 'text' as const, text: `**ERROR:** Roadmap ideas generation failed: ${msg}` }] };
      }
    })
  );
}
