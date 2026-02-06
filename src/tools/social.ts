/**
 * Social Media Tools - Draft and manage social media content
 *
 * Important: These tools DRAFT content only. Actual posting requires
 * human approval (external tier) or manual action.
 *
 * Permission tiers:
 * - read: View ideas, past drafts (automatic)
 * - create: Generate new content drafts (automatic)
 * - external: Post to social platforms (requires approval)
 */

import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import type { Tool, ToolResult, ToolExecutionContext } from '../types/index.js';
import { config } from '../config/index.js';
import { toolRegistry } from './registry.js';
import { logger } from '../config/logger.js';
import { getRoute, trackUsage } from '../models/index.js';

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
});

// ============================================
// Input Validation Schemas
// ============================================

const draftPostSchema = z.object({
  platform: z.enum(['twitter', 'linkedin', 'both']).default('both'),
  topic: z.string().min(1).max(500),
  tone: z.enum(['professional', 'casual', 'educational', 'exciting']).optional().default('professional'),
  include_cta: z.boolean().optional().default(true),
});

const contentIdeasSchema = z.object({
  count: z.number().int().min(1).max(10).optional().default(5),
  focus: z.string().max(200).optional(),
});

const weeklyCalendarSchema = z.object({
  week_start: z.string().optional(),
  themes: z.array(z.string().max(100)).optional(),
});

// ============================================
// Tools
// ============================================

/**
 * Generate content ideas for social media
 */
const generateContentIdeas: Tool = {
  name: 'social_content_ideas',
  description: 'Generate content ideas for Radl social media (Twitter/LinkedIn)',
  category: 'social',
  permissionTier: 'read',
  parameters: {
    count: {
      type: 'number',
      description: 'Number of ideas to generate (1-10)',
      optional: true,
      default: 5,
    },
    focus: {
      type: 'string',
      description: 'Focus area (e.g., "rowing tips", "product updates", "coaching insights")',
      optional: true,
    },
  },
  inputSchema: contentIdeasSchema,
  rateLimit: 10,
  async execute(params, context): Promise<ToolResult> {
    try {
      const validated = contentIdeasSchema.parse(params);
      const route = getRoute('conversation');

      const prompt = `Generate ${validated.count} social media content ideas for Radl, a rowing team management SaaS app.

Radl helps rowing coaches manage: practices, lineups, equipment, rosters, compliance.
Blue ocean features: weather integration, rigging database, seat racing (coming soon).

${validated.focus ? `Focus area: ${validated.focus}` : ''}

For each idea provide:
1. **Hook** - Opening line that grabs attention
2. **Platform** - Twitter, LinkedIn, or both
3. **Type** - Thread, single post, image post, poll
4. **Content angle** - Educational, story, feature highlight, community
5. **Best posting time** - Day and time suggestion

Target audience: rowing coaches, club administrators, collegiate programs.
Tone: knowledgeable about rowing, not corporate.`;

      const response = await anthropic.messages.create({
        model: route.model,
        max_tokens: route.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });

      trackUsage(
        route.model,
        response.usage.input_tokens,
        response.usage.output_tokens,
        'conversation',
        'social_content_ideas'
      );

      const content = response.content[0];
      const ideas = content.type === 'text' ? content.text : '';

      logger.info('Social content ideas generated', { count: validated.count });

      return { success: true, data: { ideas, count: validated.count } };
    } catch (error) {
      logger.error('social_content_ideas failed', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate content ideas',
      };
    }
  },
};

/**
 * Draft a social media post
 */
const draftPost: Tool = {
  name: 'social_draft_post',
  description: 'Draft a social media post for Twitter/LinkedIn about Radl. Human posts manually.',
  category: 'social',
  permissionTier: 'create',
  parameters: {
    platform: {
      type: 'string',
      description: 'Target platform: twitter, linkedin, or both',
      optional: true,
      default: 'both',
      enum: ['twitter', 'linkedin', 'both'],
    },
    topic: {
      type: 'string',
      description: 'What to post about',
    },
    tone: {
      type: 'string',
      description: 'Tone: professional, casual, educational, exciting',
      optional: true,
      default: 'professional',
      enum: ['professional', 'casual', 'educational', 'exciting'],
    },
    include_cta: {
      type: 'boolean',
      description: 'Include a call-to-action',
      optional: true,
      default: true,
    },
  },
  inputSchema: draftPostSchema,
  rateLimit: 10,
  async execute(params, context): Promise<ToolResult> {
    try {
      const validated = draftPostSchema.parse(params);
      const route = getRoute('conversation');

      const platformInstructions = {
        twitter: 'Twitter/X post (max 280 chars). Punchy, hashtags optional.',
        linkedin: 'LinkedIn post (max 3000 chars). Professional but authentic. Can be longer-form.',
        both: 'Both Twitter (280 chars) AND LinkedIn (longer version).',
      };

      const prompt = `Draft a ${validated.platform} social media post for Radl.

**Topic:** ${validated.topic}
**Tone:** ${validated.tone}
**Platform:** ${platformInstructions[validated.platform]}
${validated.include_cta ? '**Include:** A call-to-action (visit site, try free, etc.)' : ''}

About Radl:
- Rowing team management SaaS (web + mobile PWA)
- For coaches, clubs, and programs
- Features: practice planning, lineup management, equipment tracking, weather, rigging database
- Differentiator: built BY rowers FOR rowers. No competitor has weather, rigging, seat racing.
- URL: radl.app

Write the draft(s). Do NOT include any instructions or meta-commentary. Just the ready-to-post content.`;

      const response = await anthropic.messages.create({
        model: route.model,
        max_tokens: route.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });

      trackUsage(
        route.model,
        response.usage.input_tokens,
        response.usage.output_tokens,
        'conversation',
        'social_draft_post'
      );

      const content = response.content[0];
      const draft = content.type === 'text' ? content.text : '';

      logger.info('Social post drafted', { platform: validated.platform, topic: validated.topic });

      return {
        success: true,
        data: {
          draft,
          platform: validated.platform,
          topic: validated.topic,
          note: 'Draft only. Human must review and post manually.',
        },
      };
    } catch (error) {
      logger.error('social_draft_post failed', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to draft post',
      };
    }
  },
};

/**
 * Generate a weekly content calendar
 */
const weeklyContentCalendar: Tool = {
  name: 'social_weekly_calendar',
  description: 'Generate a weekly social media content calendar for Radl',
  category: 'social',
  permissionTier: 'read',
  parameters: {
    week_start: {
      type: 'string',
      description: 'Start date of the week (ISO format)',
      optional: true,
    },
    themes: {
      type: 'array',
      description: 'Optional themes to incorporate',
      optional: true,
    },
  },
  inputSchema: weeklyCalendarSchema,
  rateLimit: 5,
  async execute(params, context): Promise<ToolResult> {
    try {
      const validated = weeklyCalendarSchema.parse(params);
      const route = getRoute('conversation');

      const weekStart = validated.week_start || new Date().toISOString().split('T')[0];

      const prompt = `Create a weekly social media calendar for Radl (rowing team management SaaS).

Week starting: ${weekStart}
${validated.themes?.length ? `Themes to incorporate: ${validated.themes.join(', ')}` : ''}

For each weekday (Mon-Fri), provide:
1. **Platform** (Twitter, LinkedIn, or both)
2. **Content type** (post, thread, poll, image)
3. **Topic/angle**
4. **Draft content** (ready to post)
5. **Best time to post**

Content pillars for Radl:
- Product updates and features
- Rowing coaching tips
- Equipment maintenance insights
- Team management best practices
- Community highlights and stories

Mix content types. Avoid posting the same type two days in a row.
Audience: rowing coaches, club admins, collegiate programs.`;

      const response = await anthropic.messages.create({
        model: route.model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      });

      trackUsage(
        route.model,
        response.usage.input_tokens,
        response.usage.output_tokens,
        'conversation',
        'social_weekly_calendar'
      );

      const content = response.content[0];
      const calendar = content.type === 'text' ? content.text : '';

      logger.info('Weekly content calendar generated', { weekStart });

      return { success: true, data: { calendar, weekStart } };
    } catch (error) {
      logger.error('social_weekly_calendar failed', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate content calendar',
      };
    }
  },
};

// ============================================
// Registration
// ============================================

export function registerSocialTools(): void {
  toolRegistry.register(generateContentIdeas);
  toolRegistry.register(draftPost);
  toolRegistry.register(weeklyContentCalendar);

  logger.info('Social media tools registered', { count: 3 });
}
