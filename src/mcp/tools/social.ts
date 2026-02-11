/**
 * MCP Social Media Tools - Content creation with Radl brand context
 *
 * All tools are draft-only - human posts manually.
 * Radl product context is baked into every prompt.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { TaskType } from '../../types/index.js';
import { getAnthropicClient } from '../../config/anthropic.js';
import { getRoute } from '../../models/router.js';
import { trackUsage } from '../../models/token-tracker.js';
import { logger } from '../../config/logger.js';
import { withErrorTracking } from '../with-error-tracking.js';

const RADL_CONTEXT = `Radl is a rowing team management SaaS (radl.app).
Core value: Coaches plan practices with lineups; athletes know where to be.
Target: Rowing clubs, college teams, national teams.
Differentiators: Purpose-built for rowing (not generic sports), lineup planning with seat assignments, equipment tracking with QR damage reporting.
Tone: Professional but approachable, knowledgeable about rowing, not corporate-speak.
URL: https://radl.app`;

async function callModel(prompt: string, taskType: TaskType): Promise<string> {
  const route = getRoute(taskType);
  const client = getAnthropicClient();

  const response = await client.messages.create({
    model: route.model,
    max_tokens: route.maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });

  trackUsage(
    route.model,
    response.usage.input_tokens,
    response.usage.output_tokens,
    taskType,
    'social_tool'
  );

  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

export function registerSocialTools(server: McpServer): void {
  server.tool(
    'social_ideas',
    'Generate social media content ideas for Radl with brand context and audience targeting',
    {
      count: z.number().int().min(1).max(10).optional().default(5)
        .describe('Number of ideas to generate'),
      focus: z.string().max(200).optional()
        .describe('Topic focus (e.g., "launch announcement", "rowing tips")'),
    },
    withErrorTracking('social_ideas', async ({ count, focus }) => {
      const prompt = `${RADL_CONTEXT}

Generate ${count} social media content ideas for Radl.
${focus ? `Focus: ${focus}` : 'Mix of educational, promotional, and community content.'}

For each idea:
1. **Hook** - Attention-grabbing opening line
2. **Platform** - Best platform (Twitter, LinkedIn, or both)
3. **Type** - Post type (thread, image+caption, poll, video script)
4. **Why it works** - Brief reasoning

Be specific to rowing, not generic startup advice.`;

      const text = await callModel(prompt, 'social_generation');
      logger.info('MCP social ideas generated', { count });
      return { content: [{ type: 'text' as const, text }] };
    })
  );

  server.tool(
    'social_draft',
    'Draft a social media post for Twitter/LinkedIn about Radl. Human posts manually.',
    {
      platform: z.enum(['twitter', 'linkedin', 'both']).optional().default('both')
        .describe('Target platform'),
      topic: z.string().min(1).max(500)
        .describe('What the post should be about'),
      tone: z.enum(['professional', 'casual', 'educational', 'exciting']).optional().default('professional')
        .describe('Desired tone'),
    },
    withErrorTracking('social_draft', async ({ platform, topic, tone }) => {
      const constraints = platform === 'twitter'
        ? 'Max 280 characters. Punchy. Include 1-2 relevant hashtags.'
        : platform === 'linkedin'
          ? 'Professional but personable. 150-300 words. Use line breaks for readability.'
          : 'Create both a Twitter version (280 chars max) and a LinkedIn version (150-300 words).';

      const prompt = `${RADL_CONTEXT}

Draft a ${tone} social media post about: ${topic}

Platform constraints: ${constraints}

Requirements:
- Authentic voice, not salesy
- Include a clear value proposition or insight
- End with engagement prompt or CTA where natural
- Reference radl.app only if promoting directly

Return the ready-to-post draft(s).`;

      const text = await callModel(prompt, 'conversation');
      logger.info('MCP social draft created', { platform, topic });
      return { content: [{ type: 'text' as const, text }] };
    })
  );

  server.tool(
    'social_calendar',
    'Generate a weekly social media content calendar for Radl (Mon-Fri). Example: { "themes": ["product launch", "rowing tips", "team culture"] }',
    {
      themes: z.array(z.string().max(100)).max(5).optional()
        .describe('Content themes for the week'),
    },
    withErrorTracking('social_calendar', async ({ themes }) => {
      const prompt = `${RADL_CONTEXT}

Create a Mon-Fri social media content calendar for Radl.
${themes ? `Weekly themes: ${themes.join(', ')}` : 'Mix content pillars: product updates, rowing tips, team culture, behind-the-scenes, engagement.'}

For each day include:
- **Day**: Monday-Friday
- **Platform**: Twitter, LinkedIn, or both
- **Topic**: What the post covers
- **Draft**: A ready-to-post draft
- **Best time**: Suggested posting time (EST)

Keep each draft authentic and rowing-specific.`;

      const text = await callModel(prompt, 'conversation');
      logger.info('MCP social calendar generated');
      return { content: [{ type: 'text' as const, text }] };
    })
  );
}
