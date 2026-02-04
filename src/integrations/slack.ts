/**
 * Slack Integration - Handle messages and send notifications
 */

import { App, LogLevel } from '@slack/bolt';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import { processMessage, approveAction, rejectAction, getPendingApprovals } from '../agent/core.js';
import type { AgentContext } from '../types/index.js';

let app: App | null = null;

/**
 * Initialize Slack app
 */
export function initSlack(): App | null {
  if (!config.slack.botToken || !config.slack.appToken) {
    logger.warn('Slack tokens not configured, skipping Slack initialization');
    return null;
  }

  app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
    logLevel: config.app.isDev ? LogLevel.DEBUG : LogLevel.INFO,
  });

  // Handle direct messages
  app.message(async ({ message, say }) => {
    if (message.subtype !== undefined) return; // Ignore system messages
    if (!('text' in message) || !message.text) return;
    if (!('user' in message)) return;

    const context: AgentContext = {
      conversationId: `slack-${message.user}-${message.channel}`,
      userId: message.user,
      channel: 'slack',
      metadata: {
        channel: message.channel,
        thread_ts: 'thread_ts' in message ? message.thread_ts : undefined,
      },
    };

    try {
      logger.info('Processing Slack message', { user: message.user, text: message.text });
      const response = await processMessage(message.text, context);

      if (response.requiresApproval) {
        await say({
          text: `${response.message}\n\n⚠️ *Approval Required*: ${response.approvalReason}\n\nReply with \`approve\` or \`reject\` to respond.`,
          thread_ts: 'thread_ts' in message ? message.thread_ts : undefined,
        });
      } else {
        await say({
          text: response.message,
          thread_ts: 'thread_ts' in message ? message.thread_ts : undefined,
        });
      }
    } catch (error) {
      logger.error('Error processing Slack message', { error });
      await say({
        text: '❌ Sorry, I encountered an error processing your request.',
        thread_ts: 'thread_ts' in message ? message.thread_ts : undefined,
      });
    }
  });

  // Handle approve command
  app.message(/^approve$/i, async ({ message, say }) => {
    if (!('user' in message)) return;

    const pending = getPendingApprovals();
    if (pending.length === 0) {
      await say('No pending approvals.');
      return;
    }

    // Approve the most recent pending action
    const latest = pending[pending.length - 1];
    const userId = 'user' in message ? message.user : 'unknown';
    const result = await approveAction(latest.id, userId ?? 'unknown');

    if (result.success) {
      await say(`✅ Action approved and executed successfully.`);
    } else {
      await say(`❌ Error: ${result.error}`);
    }
  });

  // Handle reject command
  app.message(/^reject$/i, async ({ message, say }) => {
    if (!('user' in message)) return;

    const pending = getPendingApprovals();
    if (pending.length === 0) {
      await say('No pending approvals.');
      return;
    }

    const latest = pending[pending.length - 1];
    const userId = 'user' in message ? message.user : 'unknown';
    const result = rejectAction(latest.id, userId ?? 'unknown');

    if (result.success) {
      await say('❌ Action rejected.');
    } else {
      await say(`Error: ${result.error}`);
    }
  });

  // Handle app mentions
  app.event('app_mention', async ({ event, say }) => {
    const context: AgentContext = {
      conversationId: `slack-mention-${event.user}-${event.channel}`,
      userId: event.user,
      channel: 'slack',
      metadata: {
        channel: event.channel,
        thread_ts: event.thread_ts,
      },
    };

    try {
      // Remove the bot mention from the text
      const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

      if (!text) {
        await say({
          text: "Hi! I'm Radl Ops, your AI assistant. How can I help you today?",
          thread_ts: event.thread_ts,
        });
        return;
      }

      const response = await processMessage(text, context);
      await say({
        text: response.message,
        thread_ts: event.thread_ts,
      });
    } catch (error) {
      logger.error('Error handling app mention', { error });
      await say({
        text: '❌ Sorry, I encountered an error.',
        thread_ts: event.thread_ts,
      });
    }
  });

  return app;
}

/**
 * Start the Slack app
 */
export async function startSlack(): Promise<void> {
  if (!app) {
    app = initSlack();
  }

  if (!app) {
    logger.warn('Slack not configured, skipping start');
    return;
  }

  await app.start();
  logger.info('Slack app started');
}

/**
 * Send a message to the configured channel
 */
export async function sendMessage(text: string, threadTs?: string): Promise<void> {
  if (!app || !config.slack.channelId) {
    logger.warn('Cannot send message: Slack not configured');
    return;
  }

  try {
    await app.client.chat.postMessage({
      channel: config.slack.channelId,
      text,
      thread_ts: threadTs,
    });
  } catch (error) {
    logger.error('Failed to send Slack message', { error });
  }
}

/**
 * Send a briefing to Slack
 */
export async function sendBriefing(briefingText: string, title: string): Promise<void> {
  if (!app || !config.slack.channelId) {
    logger.warn('Cannot send briefing: Slack not configured');
    return;
  }

  try {
    await app.client.chat.postMessage({
      channel: config.slack.channelId,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: title,
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: briefingText,
          },
        },
        {
          type: 'divider',
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Generated by Radl Ops at ${new Date().toISOString()}`,
            },
          ],
        },
      ],
    });
  } catch (error) {
    logger.error('Failed to send briefing to Slack', { error });
  }
}

export { app };
