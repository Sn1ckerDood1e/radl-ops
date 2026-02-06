/**
 * Briefing Tools - Generate daily and weekly business summaries
 *
 * All briefing tools are read-tier (automatic execution, no approval needed)
 */

import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import type { Tool, ToolResult, Briefing, ToolExecutionContext } from '../types/index.js';
import { config } from '../config/index.js';
import { toolRegistry } from './registry.js';
import { logger } from '../config/logger.js';
import { audit } from '../audit/index.js';
import { getRoute, trackUsage, getCostSummaryForBriefing } from '../models/index.js';

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
});

// ============================================
// Input Validation Schemas
// ============================================

const dailyBriefingSchema = z.object({
  include_github: z.boolean().optional().default(true),
  include_social: z.boolean().optional().default(false),
  custom_focus: z.string().max(500).optional(),
});

const weeklyBriefingSchema = z.object({
  week_start: z.string().optional(),
});

const roadmapIdeasSchema = z.object({
  focus_area: z.string().max(200).optional(),
  constraint: z.string().max(200).optional(),
});

// ============================================
// Tools
// ============================================

/**
 * Generate a daily briefing
 */
const generateDailyBriefing: Tool = {
  name: 'generate_daily_briefing',
  description: 'Generate a daily briefing summarizing business activity, tasks, and priorities',
  category: 'briefing',
  permissionTier: 'read',
  parameters: {
    include_github: {
      type: 'boolean',
      description: 'Include GitHub activity summary',
      optional: true,
      default: true,
    },
    include_social: {
      type: 'boolean',
      description: 'Include social media metrics',
      optional: true,
      default: false,
    },
    custom_focus: {
      type: 'string',
      description: 'Custom area to focus on in the briefing',
      optional: true,
    },
  },
  inputSchema: dailyBriefingSchema,
  rateLimit: 5, // 5 briefings per minute
  async execute(params, context): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const validated = dailyBriefingSchema.parse(params);

      // Gather data from various sources
      const data: Record<string, unknown> = {
        date: new Date().toISOString().split('T')[0],
        timestamp: new Date().toISOString(),
      };

      // Get GitHub activity if requested
      if (validated.include_github) {
        // Use the registry's execute method for proper audit/rate limiting
        const statsResult = await toolRegistry.execute('github_repo_stats', {}, context);
        if (statsResult.success) {
          data.github = statsResult.data;
        }

        const issuesResult = await toolRegistry.execute('github_list_issues', { limit: 5 }, context);
        if (issuesResult.success) {
          data.open_issues = issuesResult.data;
        }

        const prsResult = await toolRegistry.execute('github_list_prs', { limit: 5 }, context);
        if (prsResult.success) {
          data.open_prs = prsResult.data;
        }
      }

      // Generator/Critic pattern: Haiku generates, Sonnet reviews
      const generateRoute = getRoute('briefing');
      const reviewRoute = getRoute('review');

      // Include API cost summary in briefing data
      const costSummary = getCostSummaryForBriefing();
      data.api_costs = costSummary;

      const generatePrompt = `Generate a concise daily briefing for Radl (a rowing team management SaaS).

Data available:
${JSON.stringify(data, null, 2)}

${validated.custom_focus ? `Custom focus area: ${validated.custom_focus}` : ''}

Format the briefing as:
1. **Summary** - 2-3 sentence overview
2. **Key Metrics** - Important numbers at a glance
3. **Today's Priorities** - Top 3-5 actionable items
4. **Blockers/Risks** - Any issues that need attention
5. **Wins** - Recent accomplishments to celebrate
6. **API Costs** - Token usage and costs (from data above)

Keep it brief and actionable. Use bullet points.`;

      // Pass 1: Generate with Haiku (fast, cheap)
      const draft = await anthropic.messages.create({
        model: generateRoute.model,
        max_tokens: generateRoute.maxTokens,
        messages: [{ role: 'user', content: generatePrompt }],
      });

      trackUsage(
        generateRoute.model,
        draft.usage.input_tokens,
        draft.usage.output_tokens,
        'briefing',
        'generate_daily_briefing'
      );

      const draftContent = draft.content[0];
      const draftText = draftContent.type === 'text' ? draftContent.text : '';

      // Pass 2: Review with Sonnet (quality check)
      const reviewPrompt = `Review this daily briefing for accuracy, clarity, and actionability. Fix any issues and return the improved version. If it's already good, return it as-is with minimal changes.

DRAFT BRIEFING:
${draftText}

Return ONLY the improved briefing text, no meta-commentary.`;

      const reviewed = await anthropic.messages.create({
        model: reviewRoute.model,
        max_tokens: reviewRoute.maxTokens,
        messages: [{ role: 'user', content: reviewPrompt }],
      });

      trackUsage(
        reviewRoute.model,
        reviewed.usage.input_tokens,
        reviewed.usage.output_tokens,
        'review',
        'generate_daily_briefing'
      );

      const content = reviewed.content[0];
      const briefingText = content.type === 'text' ? content.text : draftText;

      const briefing: Briefing = {
        id: `briefing_${Date.now().toString(36)}`,
        type: 'daily',
        generatedAt: new Date(),
        sections: [
          {
            title: 'Daily Briefing',
            content: briefingText,
            priority: 'high',
          },
        ],
        distribution: ['slack', 'email'],
        status: 'generated',
      };

      // Audit the briefing generation
      audit('briefing_generated', {
        channel: context.channel,
        result: 'success',
        metadata: {
          type: 'daily',
          executionTimeMs: Date.now() - startTime,
        },
      });

      logger.info('Daily briefing generated', { briefingId: briefing.id });

      return { success: true, data: briefing };
    } catch (error) {
      logger.error('generate_daily_briefing failed', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate briefing',
      };
    }
  },
};

/**
 * Generate a weekly briefing
 */
const generateWeeklyBriefing: Tool = {
  name: 'generate_weekly_briefing',
  description: 'Generate a comprehensive weekly briefing with trends and planning',
  category: 'briefing',
  permissionTier: 'read',
  parameters: {
    week_start: {
      type: 'string',
      description: 'Start date of the week (ISO format)',
      optional: true,
    },
  },
  inputSchema: weeklyBriefingSchema,
  rateLimit: 2, // 2 weekly briefings per minute
  async execute(params, context): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const validated = weeklyBriefingSchema.parse(params);

      const weekStart = validated.week_start
        ? new Date(validated.week_start)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const data: Record<string, unknown> = {
        week_start: weekStart.toISOString().split('T')[0],
        week_end: new Date().toISOString().split('T')[0],
      };

      // Gather GitHub data
      const statsResult = await toolRegistry.execute('github_repo_stats', {}, context);
      if (statsResult.success) {
        data.github = statsResult.data;
      }

      // Generator/Critic pattern for weekly briefing
      const generateRoute = getRoute('briefing');
      const reviewRoute = getRoute('review');

      // Include weekly cost analytics
      const costSummary = getCostSummaryForBriefing();
      data.api_costs = costSummary;

      const generatePrompt = `Generate a comprehensive weekly briefing for Radl (a rowing team management SaaS).

Week: ${data.week_start} to ${data.week_end}

Data available:
${JSON.stringify(data, null, 2)}

Format the briefing as:
1. **Week in Review** - High-level summary of the week
2. **Development Progress** - Features shipped, bugs fixed, technical debt addressed
3. **Metrics & Trends** - Key numbers and how they changed
4. **Challenges Faced** - Problems encountered and how they were addressed
5. **Next Week's Goals** - Top 3-5 priorities for the coming week
6. **Strategic Notes** - Any longer-term considerations
7. **API Costs** - Weekly token usage and costs

Be thorough but organized. Use headers and bullet points.`;

      // Pass 1: Generate with Haiku
      const draft = await anthropic.messages.create({
        model: generateRoute.model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: generatePrompt }],
      });

      trackUsage(
        generateRoute.model,
        draft.usage.input_tokens,
        draft.usage.output_tokens,
        'briefing',
        'generate_weekly_briefing'
      );

      const draftContent = draft.content[0];
      const draftText = draftContent.type === 'text' ? draftContent.text : '';

      // Pass 2: Review with Sonnet
      const reviewPrompt = `Review this weekly briefing for accuracy, completeness, and strategic insight. Improve it and return the final version. If it's already good, return it with minimal changes.

DRAFT BRIEFING:
${draftText}

Return ONLY the improved briefing text, no meta-commentary.`;

      const reviewed = await anthropic.messages.create({
        model: reviewRoute.model,
        max_tokens: reviewRoute.maxTokens,
        messages: [{ role: 'user', content: reviewPrompt }],
      });

      trackUsage(
        reviewRoute.model,
        reviewed.usage.input_tokens,
        reviewed.usage.output_tokens,
        'review',
        'generate_weekly_briefing'
      );

      const content = reviewed.content[0];
      const briefingText = content.type === 'text' ? content.text : draftText;

      const briefing: Briefing = {
        id: `briefing_${Date.now().toString(36)}`,
        type: 'weekly',
        generatedAt: new Date(),
        sections: [
          {
            title: 'Weekly Briefing',
            content: briefingText,
            priority: 'high',
          },
        ],
        distribution: ['slack', 'email'],
        status: 'generated',
      };

      // Audit the briefing generation
      audit('briefing_generated', {
        channel: context.channel,
        result: 'success',
        metadata: {
          type: 'weekly',
          executionTimeMs: Date.now() - startTime,
        },
      });

      logger.info('Weekly briefing generated', { briefingId: briefing.id });

      return { success: true, data: briefing };
    } catch (error) {
      logger.error('generate_weekly_briefing failed', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate weekly briefing',
      };
    }
  },
};

/**
 * Generate feature roadmap suggestions
 */
const generateRoadmapIdeas: Tool = {
  name: 'generate_roadmap_ideas',
  description: 'Brainstorm and prioritize potential features for the Radl roadmap',
  category: 'briefing',
  permissionTier: 'read',
  parameters: {
    focus_area: {
      type: 'string',
      description: 'Area to focus on (e.g., "user engagement", "coach tools", "analytics")',
      optional: true,
    },
    constraint: {
      type: 'string',
      description: 'Any constraints to consider (e.g., "mobile-first", "low effort")',
      optional: true,
    },
  },
  inputSchema: roadmapIdeasSchema,
  rateLimit: 5,
  async execute(params, context): Promise<ToolResult> {
    try {
      const validated = roadmapIdeasSchema.parse(params);

      const prompt = `You are helping plan the roadmap for Radl, a rowing team management SaaS.

Radl helps rowing coaches and clubs manage:
- Team rosters and athlete profiles
- Practice planning and scheduling
- Equipment tracking and maintenance
- Lineup management
- Compliance tracking (SafeSport, background checks)

${validated.focus_area ? `Focus area: ${validated.focus_area}` : ''}
${validated.constraint ? `Constraint: ${validated.constraint}` : ''}

Generate 5-7 feature ideas with:
1. **Feature Name** - Short, descriptive title
2. **Problem Solved** - What user pain point this addresses
3. **User Value** - Why users would want this
4. **Effort Estimate** - S/M/L/XL
5. **Priority Score** - 1-10 based on impact vs effort

Also suggest which features should be grouped together and a recommended implementation order.`;

      // Roadmap uses Opus for deep strategic reasoning
      const route = getRoute('roadmap');

      const response = await anthropic.messages.create({
        model: route.model,
        max_tokens: route.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });

      trackUsage(
        route.model,
        response.usage.input_tokens,
        response.usage.output_tokens,
        'roadmap',
        'generate_roadmap_ideas'
      );

      const content = response.content[0];
      const ideas = content.type === 'text' ? content.text : '';

      logger.info('Roadmap ideas generated', { model: route.model });

      return { success: true, data: { ideas } };
    } catch (error) {
      logger.error('generate_roadmap_ideas failed', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate roadmap ideas',
      };
    }
  },
};

// ============================================
// Registration
// ============================================

export function registerBriefingTools(): void {
  toolRegistry.register(generateDailyBriefing);
  toolRegistry.register(generateWeeklyBriefing);
  toolRegistry.register(generateRoadmapIdeas);

  logger.info('Briefing tools registered', { count: 3 });
}
