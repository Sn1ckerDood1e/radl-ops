/**
 * Briefing Tool - Generate daily and weekly business summaries
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Tool, ToolResult, Briefing } from '../types/index.js';
import { config } from '../config/index.js';
import { toolRegistry } from './registry.js';

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
});

/**
 * Generate a daily briefing
 */
const generateDailyBriefing: Tool = {
  name: 'generate_daily_briefing',
  description: 'Generate a daily briefing summarizing business activity, tasks, and priorities',
  parameters: {
    include_github: {
      type: 'boolean',
      description: 'Include GitHub activity summary',
      optional: true,
    },
    include_social: {
      type: 'boolean',
      description: 'Include social media metrics',
      optional: true,
    },
    custom_focus: {
      type: 'string',
      description: 'Custom area to focus on in the briefing',
      optional: true,
    },
  },
  async execute(params): Promise<ToolResult> {
    try {
      // Gather data from various sources
      const data: Record<string, unknown> = {
        date: new Date().toISOString().split('T')[0],
        timestamp: new Date().toISOString(),
      };

      // Get GitHub activity if requested
      if (params.include_github !== false) {
        const githubTool = toolRegistry.get('github_repo_stats');
        if (githubTool) {
          const statsResult = await githubTool.execute({});
          if (statsResult.success) {
            data.github = statsResult.data;
          }
        }

        const issuesTool = toolRegistry.get('github_list_issues');
        if (issuesTool) {
          const issuesResult = await issuesTool.execute({ limit: 5 });
          if (issuesResult.success) {
            data.open_issues = issuesResult.data;
          }
        }

        const prsTool = toolRegistry.get('github_list_prs');
        if (prsTool) {
          const prsResult = await prsTool.execute({ limit: 5 });
          if (prsResult.success) {
            data.open_prs = prsResult.data;
          }
        }
      }

      // Generate briefing with Claude
      const prompt = `Generate a concise daily briefing for Radl (a rowing team management SaaS).

Data available:
${JSON.stringify(data, null, 2)}

${params.custom_focus ? `Custom focus area: ${params.custom_focus}` : ''}

Format the briefing as:
1. **Summary** - 2-3 sentence overview
2. **Key Metrics** - Important numbers at a glance
3. **Today's Priorities** - Top 3-5 actionable items
4. **Blockers/Risks** - Any issues that need attention
5. **Wins** - Recent accomplishments to celebrate

Keep it brief and actionable. Use bullet points.`;

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content[0];
      const briefingText = content.type === 'text' ? content.text : '';

      const briefing: Briefing = {
        type: 'daily',
        generatedAt: new Date(),
        sections: [
          {
            title: 'Daily Briefing',
            content: briefingText,
            priority: 'high',
          },
        ],
      };

      return { success: true, data: briefing };
    } catch (error) {
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
  parameters: {
    week_start: {
      type: 'string',
      description: 'Start date of the week (ISO format)',
      optional: true,
    },
  },
  async execute(params): Promise<ToolResult> {
    try {
      const weekStart = params.week_start
        ? new Date(params.week_start as string)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const data: Record<string, unknown> = {
        week_start: weekStart.toISOString().split('T')[0],
        week_end: new Date().toISOString().split('T')[0],
      };

      // Gather GitHub data
      const githubTool = toolRegistry.get('github_repo_stats');
      if (githubTool) {
        const result = await githubTool.execute({});
        if (result.success) {
          data.github = result.data;
        }
      }

      // Generate weekly briefing
      const prompt = `Generate a comprehensive weekly briefing for Radl (a rowing team management SaaS).

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

Be thorough but organized. Use headers and bullet points.`;

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content[0];
      const briefingText = content.type === 'text' ? content.text : '';

      const briefing: Briefing = {
        type: 'weekly',
        generatedAt: new Date(),
        sections: [
          {
            title: 'Weekly Briefing',
            content: briefingText,
            priority: 'high',
          },
        ],
      };

      return { success: true, data: briefing };
    } catch (error) {
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
  async execute(params): Promise<ToolResult> {
    try {
      const prompt = `You are helping plan the roadmap for Radl, a rowing team management SaaS.

Radl helps rowing coaches and clubs manage:
- Team rosters and athlete profiles
- Practice planning and scheduling
- Equipment tracking and maintenance
- Lineup management
- Compliance tracking (SafeSport, background checks)

${params.focus_area ? `Focus area: ${params.focus_area}` : ''}
${params.constraint ? `Constraint: ${params.constraint}` : ''}

Generate 5-7 feature ideas with:
1. **Feature Name** - Short, descriptive title
2. **Problem Solved** - What user pain point this addresses
3. **User Value** - Why users would want this
4. **Effort Estimate** - S/M/L/XL
5. **Priority Score** - 1-10 based on impact vs effort

Also suggest which features should be grouped together and a recommended implementation order.`;

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content[0];
      const ideas = content.type === 'text' ? content.text : '';

      return { success: true, data: { ideas } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate roadmap ideas',
      };
    }
  },
};

// Register all briefing tools
export function registerBriefingTools(): void {
  toolRegistry.register(generateDailyBriefing);
  toolRegistry.register(generateWeeklyBriefing);
  toolRegistry.register(generateRoadmapIdeas);
}
