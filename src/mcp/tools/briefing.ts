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
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../../config/paths.js';
import { sendGmail, isGoogleConfigured } from '../../integrations/google.js';
import { config } from '../../config/index.js';

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

function getDeferredSummaryFromStore(store: DeferredStore): string {
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

// ---------------------------------------------------------------------------
// Markdown to HTML (inline-CSS for email clients)
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function markdownToHtml(md: string, title: string): string {
  let html = escapeHtml(md)
    // Headers
    .replace(/^### (.+)$/gm, '<h3 style="color:#1e293b;margin:16px 0 8px;">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="color:#1e293b;margin:20px 0 10px;border-bottom:1px solid #e2e8f0;padding-bottom:6px;">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="color:#0f172a;margin:0 0 16px;border-bottom:2px solid #2563eb;padding-bottom:8px;">$1</h1>')
    // Bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Horizontal rule
    .replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0;">')
    // Code
    .replace(/`(.+?)`/g, '<code style="background:#f1f5f9;padding:2px 6px;border-radius:3px;font-size:13px;">$1</code>');

  // Convert bullet lists (group consecutive lines starting with -)
  html = html.replace(
    /(?:^- .+$\n?)+/gm,
    (block) => {
      const items = block.trim().split('\n').map(line =>
        `<li style="margin:4px 0;">${line.replace(/^- /, '')}</li>`
      );
      return `<ul style="margin:8px 0;padding-left:24px;">${items.join('')}</ul>`;
    }
  );

  // Wrap paragraphs (non-HTML lines separated by blank lines)
  html = html
    .split('\n\n')
    .map(block => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('<')) return trimmed;
      return `<p style="margin:8px 0;line-height:1.5;">${trimmed}</p>`;
    })
    .join('\n');

  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,system-ui,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#1a1a1a;background:#ffffff;">
<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:24px;">
<h1 style="color:#0f172a;margin:0 0 4px;font-size:22px;">${escapeHtml(title)}</h1>
<p style="color:#64748b;margin:0 0 20px;font-size:14px;">${date}</p>
${html}
<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0 12px;">
<p style="color:#94a3b8;font-size:12px;margin:0;">Generated by Radl Ops AI Chief of Staff</p>
</div>
</body></html>`;
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
        .describe('Sanitized production status summary. Use counts and status strings only — do NOT include raw error messages, stack traces, or PII from issue titles.'),
      calendar_context: z.string().max(2000).optional()
        .describe('Today\'s calendar events from Google Calendar MCP. Include meetings, blocked time, deadlines.'),
      deferred_context: z.string().max(2000).optional()
        .describe('Deferred tech debt summary. Auto-populated if omitted — pass "none" to skip.'),
      custom_focus: z.string().max(500).optional()
        .describe('Custom area to focus on in the briefing'),
      deliver_via_gmail: z.boolean().optional()
        .describe('Send briefing via Gmail after generation. Requires Google OAuth credentials.'),
      recipient: z.string().email().max(100).optional()
        .describe('Email recipient (defaults to GOOGLE_BRIEFING_RECIPIENT config)'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    withErrorTracking('daily_briefing', async ({ github_context, monitoring_context, calendar_context, deferred_context, custom_focus, deliver_via_gmail, recipient }) => {
      const costSummary = getCostSummaryForBriefing();
      const date = new Date().toISOString().split('T')[0];

      // Load deferred items once for both summary and count
      const deferredStore = loadDeferredItems();
      const unresolvedCount = deferredStore.items.filter(i => !i.resolved).length;

      // Auto-populate deferred context if not provided
      const deferredSummary = deferred_context === 'none' ? ''
        : deferred_context ?? getDeferredSummaryFromStore(deferredStore);

      const prompt = `Generate a concise daily briefing for Radl (a rowing team management SaaS).

Date: ${date}

${github_context ? `GitHub Activity:\n${github_context}\n` : ''}
${monitoring_context ? `Production Status:\n${monitoring_context}\n` : ''}
${calendar_context ? `Today's Calendar:\n${calendar_context}\n` : ''}
${deferredSummary ? `Tech Debt (${unresolvedCount} items):\n${deferredSummary}\n` : ''}
API Costs: ${costSummary}
${custom_focus ? `\nCustom focus area: ${custom_focus}` : ''}

Format the briefing as:
1. **Summary** - 2-3 sentence overview
2. **Key Metrics** - Important numbers at a glance
3. **Today's Priorities** - Top 3-5 actionable items (consider calendar and tech debt)
4. **Production Health** - Group issues by severity:
   - **Critical** (act now): deploy failures, auth errors, DB connection issues
   - **High** (act today): error rate spikes, security advisories, failed checks
   - **Medium** (this week): performance warnings, deprecation notices
   - **Low** (note): transient errors, minor advisor suggestions
   If no issues at a severity level, omit that level. If all clear, say "All services healthy."
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

      // Gmail delivery
      let deliveryNote = '';
      if (deliver_via_gmail) {
        if (!isGoogleConfigured()) {
          deliveryNote = '\n\n**Gmail delivery skipped:** Google OAuth credentials not configured.';
        } else {
          try {
            const to = recipient ?? config.google.briefingRecipient;
            const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
            const subject = `Daily Briefing — ${dayName}`;
            const htmlBody = markdownToHtml(result.finalOutput, 'Daily Briefing');
            const { messageId } = await sendGmail({ to, subject, htmlBody });
            deliveryNote = `\n\n**Sent via Gmail** to ${to} (message: ${messageId})`;
            logger.info('Daily briefing sent via Gmail', { to, messageId });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            deliveryNote = `\n\n**Gmail delivery failed:** ${msg}`;
            logger.error('Gmail delivery failed', { error: msg });
          }
        }
      }

      return { content: [{ type: 'text' as const, text: result.finalOutput + errorInfo + meta + deliveryNote }] };
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
      deliver_via_gmail: z.boolean().optional()
        .describe('Send briefing via Gmail after generation. Requires Google OAuth credentials.'),
      recipient: z.string().email().max(100).optional()
        .describe('Email recipient (defaults to GOOGLE_BRIEFING_RECIPIENT config)'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    withErrorTracking('weekly_briefing', async ({ github_context, monitoring_context, calendar_context, week_start, deliver_via_gmail, recipient }) => {
      const start = week_start ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const end = new Date().toISOString().split('T')[0];
      const costSummary = getCostSummaryForBriefing();
      const deferredStore = loadDeferredItems();
      const deferredSummary = getDeferredSummaryFromStore(deferredStore);
      const unresolvedCount = deferredStore.items.filter(i => !i.resolved).length;

      const prompt = `Generate a comprehensive weekly briefing for Radl (a rowing team management SaaS).

Week: ${start} to ${end}

${github_context ? `GitHub Activity:\n${github_context}\n` : ''}
${monitoring_context ? `Production Health This Week:\n${monitoring_context}\n` : ''}
${calendar_context ? `Calendar Summary:\n${calendar_context}\n` : ''}
${deferredSummary ? `Tech Debt Backlog (${unresolvedCount} items):\n${deferredSummary}\n` : ''}
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

      // Gmail delivery
      let deliveryNote = '';
      if (deliver_via_gmail) {
        if (!isGoogleConfigured()) {
          deliveryNote = '\n\n**Gmail delivery skipped:** Google OAuth credentials not configured.';
        } else {
          try {
            const to = recipient ?? config.google.briefingRecipient;
            const weekLabel = `${start} to ${end}`;
            const subject = `Weekly Briefing — ${weekLabel}`;
            const htmlBody = markdownToHtml(result.finalOutput, 'Weekly Briefing');
            const { messageId } = await sendGmail({ to, subject, htmlBody });
            deliveryNote = `\n\n**Sent via Gmail** to ${to} (message: ${messageId})`;
            logger.info('Weekly briefing sent via Gmail', { to, messageId });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            deliveryNote = `\n\n**Gmail delivery failed:** ${msg}`;
            logger.error('Weekly Gmail delivery failed', { error: msg });
          }
        }
      }

      return { content: [{ type: 'text' as const, text: result.finalOutput + errorInfo + meta + deliveryNote }] };
    })
  );

  server.tool(
    'daily_summary',
    'Generate an end-of-day summary email. Scans completed sprints from today, commit messages, learnings, and unresolved blockers. Sends via Gmail.',
    {
      deliver_via_gmail: z.boolean().optional()
        .describe('Send summary via Gmail after generation. Requires Google OAuth credentials.'),
      recipient: z.string().email().max(100).optional()
        .describe('Email recipient (defaults to GOOGLE_BRIEFING_RECIPIENT config)'),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    withErrorTracking('daily_summary', async ({ deliver_via_gmail, recipient }) => {
      const { radlDir, knowledgeDir } = getConfig();
      const sprintDir = join(radlDir, '.planning', 'sprints');
      const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

      // 1. Scan completed sprints from today
      interface CompletedSprint {
        id: string;
        phase: string;
        title: string;
        estimate: string;
        actualTime: string;
        completedTasks: Array<{ message: string; completedAt: string }>;
        blockers: Array<{ description: string; time: string }>;
        commit: string;
      }

      const todaySprints: CompletedSprint[] = [];
      try {
        const files = readdirSync(sprintDir).filter(f => f.startsWith('completed-'));
        for (const file of files) {
          try {
            const data = JSON.parse(readFileSync(join(sprintDir, file), 'utf-8')) as CompletedSprint & { endTime?: string };
            const endDate = (data.endTime ?? '').split('T')[0];
            if (endDate === todayStr) {
              todaySprints.push(data);
            }
          } catch {
            // Skip malformed files
          }
        }
      } catch {
        // Sprint directory missing — no sprints
      }

      // 2. Load today's learnings
      interface LessonsStore {
        lessons: Array<{ id: number; situation: string; learning: string; date: string }>;
      }
      const lessonsPath = join(knowledgeDir, 'lessons.json');
      let todayLessons: LessonsStore['lessons'] = [];
      try {
        if (existsSync(lessonsPath)) {
          const store = JSON.parse(readFileSync(lessonsPath, 'utf-8')) as LessonsStore;
          todayLessons = store.lessons.filter(l => l.date.startsWith(todayStr));
        }
      } catch {
        // Skip if parse fails
      }

      // 3. Build summary sections
      const sections: string[] = [];

      // Header
      const dayName = new Date().toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      });
      sections.push(`# End-of-Day Summary\n\n**${dayName}**`);

      // Sprints completed
      if (todaySprints.length > 0) {
        sections.push('## Sprints Completed');
        let totalEstMin = 0;
        let totalActMin = 0;

        for (const sprint of todaySprints) {
          const taskCount = sprint.completedTasks?.length ?? 0;
          sections.push(`### ${sprint.phase}: ${sprint.title}`);
          sections.push(`- **Estimated:** ${sprint.estimate} | **Actual:** ${sprint.actualTime} | **Tasks:** ${taskCount} | **Commit:** \`${sprint.commit}\``);

          if (sprint.completedTasks?.length > 0) {
            for (const task of sprint.completedTasks) {
              sections.push(`  - ${task.message}`);
            }
          }

          // Parse times for totals
          const estMatch = sprint.estimate?.match(/(\d+(?:\.\d+)?)\s*h/i);
          const actMatch = sprint.actualTime?.match(/(\d+(?:\.\d+)?)\s*h/i);
          const estMinMatch = sprint.estimate?.match(/(\d+)\s*m/i);
          const actMinMatch = sprint.actualTime?.match(/(\d+)\s*m/i);

          if (estMatch) totalEstMin += parseFloat(estMatch[1]) * 60;
          if (estMinMatch) totalEstMin += parseInt(estMinMatch[1], 10);
          if (actMatch) totalActMin += parseFloat(actMatch[1]) * 60;
          if (actMinMatch) totalActMin += parseInt(actMinMatch[1], 10);
        }

        const fmtTime = (mins: number) => {
          const h = Math.floor(mins / 60);
          const m = Math.round(mins % 60);
          return h > 0 ? `${h}h ${m}m` : `${m}m`;
        };

        sections.push(`\n**Totals:** ${todaySprints.length} sprint(s) | Est: ${fmtTime(totalEstMin)} | Actual: ${fmtTime(totalActMin)}`);
        if (totalEstMin > 0 && totalActMin > 0) {
          const ratio = Math.round((totalActMin / totalEstMin) * 100);
          sections.push(`**Efficiency:** ${ratio}% of estimated time`);
        }
      } else {
        sections.push('## Sprints Completed\n\nNo sprints completed today.');
      }

      // Blockers
      const allBlockers = todaySprints.flatMap(s => (s.blockers ?? []).map(b => ({
        sprint: s.phase,
        ...b,
      })));
      if (allBlockers.length > 0) {
        sections.push('## Unresolved Blockers');
        for (const blocker of allBlockers) {
          sections.push(`- **${blocker.sprint}:** ${blocker.description}`);
        }
      }

      // Learnings
      if (todayLessons.length > 0) {
        sections.push('## Learnings Extracted');
        for (const lesson of todayLessons) {
          sections.push(`- **${lesson.situation}** — ${lesson.learning}`);
        }
      }

      // API costs
      const costSummary = getCostSummaryForBriefing();
      sections.push(`## API Costs\n\n${costSummary}`);

      const summaryMarkdown = sections.join('\n\n');

      // Gmail delivery
      let deliveryNote = '';
      if (deliver_via_gmail) {
        if (!isGoogleConfigured()) {
          deliveryNote = '\n\n**Gmail delivery skipped:** Google OAuth credentials not configured.';
        } else {
          try {
            const to = recipient ?? config.google.briefingRecipient;
            const subject = `End-of-Day Summary — ${dayName}`;
            const htmlBody = markdownToHtml(summaryMarkdown, 'End-of-Day Summary');
            const { messageId } = await sendGmail({ to, subject, htmlBody });
            deliveryNote = `\n\n**Sent via Gmail** to ${to} (message: ${messageId})`;
            logger.info('EOD summary sent via Gmail', { to, messageId });
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Unknown error';
            deliveryNote = `\n\n**Gmail delivery failed:** ${msg}`;
            logger.error('EOD Gmail delivery failed', { error: msg });
          }
        }
      }

      return { content: [{ type: 'text' as const, text: summaryMarkdown + deliveryNote }] };
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
